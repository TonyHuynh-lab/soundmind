from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import pandas as pd
import numpy as np
import joblib

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5000", "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

knn       = joblib.load("artifacts/knn_model.pkl")
scaler    = joblib.load("artifacts/scaler.pkl")
df_clean  = pd.read_parquet("artifacts/tracks.parquet")
scaled_df = pd.read_parquet("artifacts/scaled_df.parquet")

feature_matrix = scaled_df.values

AUDIO_COLS = ['Danceability', 'Energy', 'Loudness', 'Speechiness',
              'Acousticness', 'Instrumentalness', 'Valence', 'Tempo']
GENRE_COLS = [c for c in scaled_df.columns if c not in AUDIO_COLS]

print(f"Ready — {len(df_clean)} tracks, {len(GENRE_COLS)} genres")


class RecommendRequest(BaseModel):
    Song:             str
    Artists:          str
    n:                int = 10
    Danceability:     Optional[float] = None
    Energy:           Optional[float] = None
    Loudness:         Optional[float] = None
    Speechiness:      Optional[float] = None
    Acousticness:     Optional[float] = None
    Instrumentalness: Optional[float] = None
    Valence:          Optional[float] = None
    Tempo:            Optional[float] = None
    Genre:            Optional[str] = None

class Track(BaseModel):
    Song:       str
    Artists:    str
    Genre:      str
    Similarity: float

class RecommendResponse(BaseModel):
    seed_track:      str
    seed_artist:     str
    fallback:        str  # 'knn' | 'feature' | 'genre'
    recommendations: list[Track]


def _has_features(req: RecommendRequest) -> bool:
    return all(getattr(req, col) is not None for col in AUDIO_COLS)


def _build_results(neighbor_ids, raw_distances, clip: bool = False) -> list[dict]:
    sims = 1 - raw_distances
    if clip:
        sims = np.clip(sims, 0, 1)
    id_to_sim = {tid: round(float(s), 3) for tid, s in zip(neighbor_ids, sims)}
    results = (
        df_clean[df_clean["ID"].isin(neighbor_ids)]
        .drop_duplicates("ID")[["Song", "Artists", "Genre", "ID"]]
        .copy()
    )
    results["Similarity"] = results["ID"].map(id_to_sim)
    return results.drop(columns=["ID"]).to_dict(orient="records")


def _knn_recommend(track_id: str, n: int) -> list[dict]:
    track_vector = scaled_df.loc[track_id].values.reshape(1, -1)
    distances, indices = knn.kneighbors(track_vector, n_neighbors=n + 1)
    neighbor_ids = scaled_df.iloc[indices[0][1:]].index
    return _build_results(neighbor_ids, distances[0][1:])


def _feature_recommend(req: RecommendRequest, n: int) -> list[dict]:
    audio_vals = [getattr(req, col) for col in AUDIO_COLS]
    genre_vec  = [0.0] * len(GENRE_COLS)
    if req.Genre:
        genre_lower = req.Genre.lower().strip()
        for i, g in enumerate(GENRE_COLS):
            if g.lower() == genre_lower:
                genre_vec[i] = 1.0
                break
    raw_vec    = np.array(audio_vals + genre_vec, dtype=float).reshape(1, -1)
    scaled_vec = scaler.transform(raw_vec)
    distances, indices = knn.kneighbors(scaled_vec, n_neighbors=n)
    neighbor_ids = scaled_df.iloc[indices[0]].index
    return _build_results(neighbor_ids, distances[0], clip=True)


def _genre_recommend(req: RecommendRequest, n: int) -> list[dict]:
    subset = df_clean
    if req.Genre:
        filtered = df_clean[df_clean["Genre"].str.lower() == req.Genre.lower().strip()]
        if not filtered.empty:
            subset = filtered
    sample = subset.sample(min(n, len(subset)))
    results = sample[["Song", "Artists", "Genre"]].copy()
    results["Similarity"] = 0.0
    return results.to_dict(orient="records")


@app.post("/recommend", response_model=RecommendResponse)
def recommend(req: RecommendRequest):
    # Tier 1: track found in dataset → KNN
    matches = df_clean[
        (df_clean["Song"].str.lower() == req.Song.lower()) &
        (df_clean["Artists"].str.lower().str.contains(req.Artists.lower()))
    ]
    if not matches.empty:
        track_id = matches.iloc[0]["ID"]
        if track_id in scaled_df.index:
            return RecommendResponse(
                seed_track=req.Song,
                seed_artist=req.Artists,
                fallback="knn",
                recommendations=[Track(**r) for r in _knn_recommend(track_id, req.n)]
            )

    # Tier 2: not found, audio features available → feature-based KNN
    if _has_features(req):
        return RecommendResponse(
            seed_track=req.Song,
            seed_artist=req.Artists,
            fallback="feature",
            recommendations=[Track(**r) for r in _feature_recommend(req, req.n)]
        )

    # Tier 3: no features → genre/random fallback
    return RecommendResponse(
        seed_track=req.Song,
        seed_artist=req.Artists,
        fallback="genre",
        recommendations=[Track(**r) for r in _genre_recommend(req, req.n)]
    )


@app.get("/health")
def health():
    return {"status": "ok", "tracks_loaded": len(df_clean)}
