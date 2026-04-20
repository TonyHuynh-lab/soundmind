from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np
import joblib

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5000", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# load artifacts
knn        = joblib.load("artifacts/knn_model.pkl")
scaler     = joblib.load("artifacts/scaler.pkl")
df_clean   = pd.read_parquet("artifacts/tracks.parquet")
scaled_df  = pd.read_parquet("artifacts/scaled_df.parquet")

feature_matrix = scaled_df.values
print(f"Ready — {len(df_clean)} tracks loaded")

# schemas
class RecommendRequest(BaseModel):
    Song:        str
    Artists:     str
    n:           int = 10

class Track(BaseModel):
    Song:        str
    Artists:     str
    Genre:       str
    Similarity:  float

class RecommendResponse(BaseModel):
    seed_track:  str
    seed_artist: str
    recommendations: list[Track]

# recommend api endpoint
@app.post("/recommend", response_model=RecommendResponse)
def recommend(req: RecommendRequest):
    # find the seed track
    matches = df_clean[
        (df_clean["Song"].str.lower() == req.Song.lower()) &
        (df_clean["Artists"].str.lower().str.contains(req.Artists.lower()))
    ]

    if matches.empty:
        raise HTTPException(
            status_code=404,
            detail=f'Track "{req.Song}" by "{req.Artists}" not found'
        )

    track_id = matches.iloc[0]["ID"]

    if track_id not in scaled_df.index:
        raise HTTPException(
            status_code=404,
            detail=f'Track ID "{track_id}" not in feature matrix'
        )

    # call knn
    track_vector = scaled_df.loc[track_id].values.reshape(1, -1)
    distances, indices = knn.kneighbors(track_vector, n_neighbors=req.n + 1)

    neighbor_indices   = indices[0][1:]
    neighbor_distances = distances[0][1:]
    neighbor_track_ids = scaled_df.iloc[neighbor_indices].index

    # build results
    results = df_clean[df_clean["ID"].isin(neighbor_track_ids)][
        ["Song", "Artists", "Genre"]
    ].copy()
    results["Similarity"] = (1 - neighbor_distances).round(3)

    recommendations = results.to_dict(orient="records")

    return RecommendResponse(
        seed_track=req.Song,
        seed_artist=req.Artists,
        recommendations=[Track(**r) for r in recommendations]
    )

@app.get("/health")
def health():
    return {
        "status": "ok",
        "tracks_loaded": len(df_clean)
    }