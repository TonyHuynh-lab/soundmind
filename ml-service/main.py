import os, json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import pandas as pd
import numpy as np
import joblib
from dotenv import load_dotenv
from train_mf import train_and_save

load_dotenv('../server/.env')  # read MONGO_URI from server's .env
load_dotenv()                  # fallback: ml-service/.env

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5000", "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- KNN artifacts ---
knn       = joblib.load("artifacts/knn_model.pkl")
scaler    = joblib.load("artifacts/scaler.pkl")
df_clean  = pd.read_parquet("artifacts/tracks.parquet")
scaled_df = pd.read_parquet("artifacts/scaled_df.parquet")

feature_matrix = scaled_df.values

AUDIO_COLS = ['Danceability', 'Energy', 'Loudness', 'Speechiness',
              'Acousticness', 'Instrumentalness', 'Valence', 'Tempo']
GENRE_COLS = [c for c in scaled_df.columns if c not in AUDIO_COLS]

print(f"KNN ready — {len(df_clean)} tracks, {len(GENRE_COLS)} genres")

class _MFModel:
    """Lightweight wrapper around saved numpy factor arrays."""
    def __init__(self, user_factors, item_factors):
        self.user_factors = user_factors
        self.item_factors = item_factors

    def recommend(self, userid, user_items, N=10, filter_already_liked_items=True):
        scores = self.item_factors @ self.user_factors[userid]
        if filter_already_liked_items and user_items is not None:
            liked = getattr(user_items, 'indices', None)
            if liked is None:
                liked = np.where(np.asarray(user_items).ravel() > 0)[0]
            filtered = scores.copy()
            filtered[liked] = -np.inf
            # Fall back to unfiltered if everything was liked (cold-start / single user)
            if np.isfinite(filtered).any():
                scores = filtered
        n = min(N, int(np.isfinite(scores).sum()))
        if n == 0:
            return np.array([], dtype=np.int32), np.array([], dtype=np.float32)
        top_n = np.argpartition(scores, -n)[-n:]
        top_n = top_n[np.argsort(-scores[top_n])]
        return top_n.astype(np.int32), scores[top_n].astype(np.float32)


# --- MF artifacts (loaded if available) ---
mf_model     = None
mf_user_item = None  # (users × items) sparse CSR
mf_encodings = None


def _load_mf():
    global mf_model, mf_user_item, mf_encodings
    try:
        user_factors = np.load("artifacts/mf_user_factors.npy")
        item_factors = np.load("artifacts/mf_item_factors.npy")
        mf_model     = _MFModel(user_factors, item_factors)
        import scipy.sparse as sp
        mf_user_item = sp.load_npz("artifacts/mf_user_item.npz")
        with open("artifacts/mf_encodings.json") as f:
            mf_encodings = json.load(f)
        print(f"MF ready — {len(mf_encodings['users'])} users, "
              f"{len(mf_encodings['items'])} items")
    except FileNotFoundError:
        print("No MF model found — run train_mf.py to create one")


_load_mf()


# --- Schemas ---

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

class MFRequest(BaseModel):
    userId: str
    n:      int = 10

class MFResponse(BaseModel):
    recommendations: list[Track]
    message:         str = ""


# --- KNN helpers ---

def _has_features(req: RecommendRequest) -> bool:
    return all(getattr(req, col) is not None for col in AUDIO_COLS)


def _build_results(neighbor_ids, raw_distances, n: int, clip: bool = False) -> list[dict]:
    sims = 1 - raw_distances
    if clip:
        sims = np.clip(sims, 0, 1)
    id_to_sim = {tid: round(float(s), 3) for tid, s in zip(neighbor_ids, sims)}
    results = (
        df_clean[df_clean["ID"].isin(neighbor_ids)]
        .drop_duplicates("ID")
        .drop_duplicates(["Song", "Artists"])[["Song", "Artists", "Genre", "ID"]]
        .copy()
    )
    results["Similarity"] = results["ID"].map(id_to_sim).abs()
    results = results.sort_values("Similarity", ascending=False).head(n)
    return results.drop(columns=["ID"]).to_dict(orient="records")


def _knn_recommend(track_id: str, n: int) -> list[dict]:
    track_vector = scaled_df.loc[track_id].values.reshape(1, -1)
    distances, indices = knn.kneighbors(track_vector, n_neighbors=n * 3 + 1)
    neighbor_ids = scaled_df.iloc[indices[0][1:]].index
    return _build_results(neighbor_ids, distances[0][1:], n)


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
    distances, indices = knn.kneighbors(scaled_vec, n_neighbors=n * 3)
    neighbor_ids = scaled_df.iloc[indices[0]].index
    return _build_results(neighbor_ids, distances[0], n, clip=True)


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


# --- MF helper ---

def _resolve_track(track_id: str) -> dict | None:
    """Resolve a trackId (Spotify ID or song title) to Song/Artists/Genre."""
    row = df_clean[df_clean["ID"] == track_id]
    if row.empty:
        row = df_clean[df_clean["Song"].str.lower() == track_id.lower()]
    if row.empty:
        return None
    r = row.iloc[0]
    return {"Song": r["Song"], "Artists": r["Artists"], "Genre": r["Genre"]}


# --- Endpoints ---

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


@app.post("/train-mf")
def train_mf_endpoint():
    uri = os.environ.get('MONGO_URI')
    if not uri:
        from fastapi import HTTPException
        raise HTTPException(500, "MONGO_URI not configured")
    result = train_and_save(uri)
    _load_mf()  # hot-reload into memory
    return result


@app.post("/recommend-mf", response_model=MFResponse)
def recommend_mf(req: MFRequest):
    if mf_model is None:
        return MFResponse(recommendations=[], message="not_trained")

    user_map = mf_encodings['users']
    if req.userId not in user_map:
        return MFResponse(recommendations=[], message="no_feedback")

    uid      = user_map[req.userId]
    user_row = mf_user_item[uid]
    ids, scores = mf_model.recommend(uid, user_row, N=req.n * 3,
                                     filter_already_liked_items=True)

    items_reverse = mf_encodings['items_reverse']
    results = []
    seen = set()
    for idx, score in zip(ids.tolist(), scores.tolist()):
        if len(results) >= req.n:
            break
        track_id = items_reverse.get(str(idx))
        if not track_id:
            continue
        info = _resolve_track(track_id)
        if info:
            key = (info["Song"].lower(), info["Artists"].lower())
            if key in seen:
                continue
            seen.add(key)
            results.append(Track(**info, Similarity=round(float(score), 3)))

    return MFResponse(recommendations=results)


_umap_data: dict | None = None


def _compute_umap() -> dict:
    try:
        import umap as umap_lib
    except ImportError:
        return {"error": "umap-learn not installed", "points": []}

    sample = scaled_df.sample(min(5000, len(scaled_df)), random_state=42)
    print(f"Computing UMAP on {len(sample)} tracks…", flush=True)
    reducer = umap_lib.UMAP(n_neighbors=15, min_dist=0.1, n_components=2,
                            random_state=42, verbose=False)
    embedding = reducer.fit_transform(sample.values)

    meta = df_clean.drop_duplicates("ID").set_index("ID")[["Song", "Artists", "Genre"]]
    points = []
    for track_id, (x, y) in zip(sample.index, embedding):
        if track_id not in meta.index:
            continue
        row = meta.loc[track_id]
        points.append({
            "id": track_id,
            "x": round(float(x), 4),
            "y": round(float(y), 4),
            "song": row["Song"],
            "artists": row["Artists"],
            "genre": row["Genre"],
        })
    print(f"UMAP done — {len(points)} points", flush=True)
    return {"points": points}


@app.get("/umap")
def get_umap():
    global _umap_data
    if _umap_data is None:
        _umap_data = _compute_umap()
    return _umap_data


@app.get("/health")
def health():
    return {
        "status":       "ok",
        "tracks_loaded": len(df_clean),
        "mf_ready":     mf_model is not None,
    }
