"""
Run from ml-service/ after collecting feedback:
  python train_mf.py

Or trigger via:
  POST http://localhost:8000/train-mf
"""
import os, sys, json
import numpy as np
import scipy.sparse as sparse
import pymongo
from pymongo.uri_parser import parse_uri
from dotenv import load_dotenv

ACTION_WEIGHTS = {'like': 4.0, 'play': 1.0}  # skip = excluded


class ImplicitALS:
    """
    ALS for implicit feedback (Hu, Koren & Volinsky 2008).
    Pure NumPy — no C compiler required.
    """

    def __init__(self, factors=50, iterations=20, regularization=0.01, alpha=40):
        self.factors = factors
        self.iterations = iterations
        self.regularization = regularization
        self.alpha = alpha
        self.user_factors = None
        self.item_factors = None

    def fit(self, item_user):
        """item_user: (n_items, n_users) sparse CSR matrix of interaction weights."""
        n_items, n_users = item_user.shape
        f = self.factors
        rng = np.random.default_rng(42)
        self.user_factors = rng.normal(0, 0.01, (n_users, f)).astype(np.float32)
        self.item_factors = rng.normal(0, 0.01, (n_items, f)).astype(np.float32)

        user_item = item_user.T.tocsr()

        for it in range(self.iterations):
            self._als_step(self.user_factors, self.item_factors, user_item)
            self._als_step(self.item_factors, self.user_factors, item_user)
            print(f"  ALS iteration {it + 1}/{self.iterations}", flush=True)

    def _als_step(self, factors_to_update, other_factors, interactions):
        """Solve for factors_to_update given other_factors and the interaction matrix."""
        f   = self.factors
        reg = self.regularization
        α   = self.alpha

        YtY     = other_factors.T @ other_factors           # (f, f)
        reg_eye = reg * np.eye(f, dtype=np.float32)

        for u in range(factors_to_update.shape[0]):
            row = interactions.getrow(u)
            if row.nnz == 0:
                continue
            cols = row.indices
            r_ui = row.data.astype(np.float32)
            c_ui = 1.0 + α * r_ui                          # confidence
            Y_u  = other_factors[cols]                     # (nnz, f)

            # A = Y^T Y + Y_u^T diag(c-1) Y_u + λI
            # b = Y_u^T c  (p_ui = 1 for all interacted items)
            A = YtY + (Y_u * (c_ui - 1.0)[:, None]).T @ Y_u + reg_eye
            b = Y_u.T @ c_ui
            factors_to_update[u] = np.linalg.solve(A, b)

    def recommend(self, userid, user_items, N=10, filter_already_liked_items=True):
        """
        Returns (item_indices, scores) for top-N recommendations.
        user_items: sparse row (1, n_items) for this user.
        """
        scores = self.item_factors @ self.user_factors[userid]  # (n_items,)

        if filter_already_liked_items and user_items is not None:
            liked = getattr(user_items, 'indices', None)
            if liked is None:
                liked = np.where(np.asarray(user_items).ravel() > 0)[0]
            scores[liked] = -np.inf

        n = min(N, len(scores))
        top_n = np.argpartition(scores, -n)[-n:]
        top_n = top_n[np.argsort(-scores[top_n])]
        return top_n.astype(np.int32), scores[top_n].astype(np.float32)


def train_and_save(mongo_uri: str) -> dict:
    client  = pymongo.MongoClient(mongo_uri)
    db_name = parse_uri(mongo_uri).get('database') or 'test'
    db      = client[db_name]
    docs   = list(db.feedbacks.find({}))
    client.close()

    if not docs:
        return {'status': 'no_data', 'users': 0, 'items': 0, 'interactions': 0}

    # Aggregate: sum weights for repeated user-item interactions
    agg = {}
    for f in docs:
        if f['action'] not in ACTION_WEIGHTS:
            continue
        key = (f['userId'], f['trackId'])
        agg[key] = agg.get(key, 0.0) + ACTION_WEIGHTS[f['action']]

    if not agg:
        return {'status': 'only_skips', 'users': 0, 'items': 0, 'interactions': 0}

    users    = sorted({k[0] for k in agg})
    items    = sorted({k[1] for k in agg})
    user_idx = {u: i for i, u in enumerate(users)}
    item_idx = {t: i for i, t in enumerate(items)}

    # Build (items × users) sparse matrix — ALS expects this orientation for fit()
    rows, cols, data = [], [], []
    for (uid, tid), w in agg.items():
        rows.append(item_idx[tid])
        cols.append(user_idx[uid])
        data.append(w)

    item_user = sparse.csr_matrix(
        (data, (rows, cols)),
        shape=(len(items), len(users)),
        dtype=np.float32,
    )
    user_item = item_user.T.tocsr()  # (users × items) — needed for recommend()

    print(f"Training ALS: {len(users)} users, {len(items)} items …")
    model = ImplicitALS(factors=50, iterations=20, regularization=0.01)
    model.fit(item_user)

    os.makedirs('artifacts', exist_ok=True)
    np.save('artifacts/mf_user_factors.npy', model.user_factors)
    np.save('artifacts/mf_item_factors.npy', model.item_factors)
    sparse.save_npz('artifacts/mf_user_item.npz', user_item)
    with open('artifacts/mf_encodings.json', 'w') as fh:
        json.dump({
            'users':         user_idx,
            'items':         item_idx,
            'items_reverse': {str(v): k for k, v in item_idx.items()},
        }, fh)

    return {
        'status':       'ok',
        'users':        len(users),
        'items':        len(items),
        'interactions': len(agg),
    }


if __name__ == '__main__':
    load_dotenv('../server/.env')  # read MONGO_URI from server's .env
    load_dotenv()                  # fallback: ml-service/.env
    uri = os.environ.get('MONGO_URI')
    if not uri:
        print('Error: MONGO_URI not set')
        sys.exit(1)
    result = train_and_save(uri)
    print(result)
