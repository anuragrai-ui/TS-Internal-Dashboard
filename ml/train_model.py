"""Train an unsupervised IsolationForest escalation-risk anomaly model on
real exported Jira tickets, evaluate it against the existing rule-based
heuristic as a proxy signal (there is no genuine "did this escalate" label
in this project), and export it to ONNX for in-process Node inference.

Usage:
    python3 ml/train_model.py --data ml/data/jira_export.jsonl
"""

import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import IsolationForest
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

from feature_schema import (
    FEATURE_ORDER,
    IMMEDIATE_KEYWORDS,
    NEGATIVE_TOKENS,
    SEVERITY_RANK_KEYWORDS,
    WATCH_KEYWORDS,
    compute_features,
)
from heuristic_proxy import heuristic_risk_level

REPO_ROOT = Path(__file__).resolve().parent.parent
TARGET_OPSET = {"": 15, "ai.onnx.ml": 3}


def load_issues(path: Path) -> list[dict]:
    issues = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                issues.append(json.loads(line))
    return issues


def evaluate(model: IsolationForest, X: np.ndarray, issues: list[dict], thresholds: dict) -> dict:
    scores = model.decision_function(X)
    heuristic = [heuristic_risk_level(issue) for issue in issues]
    heuristic_levels = [level for level, _ in heuristic]

    model_levels = np.where(
        scores <= thresholds["immediate"],
        "immediate",
        np.where(scores <= thresholds["watch"], "watch", "normal"),
    )

    level_counts = {level: int(np.sum(model_levels == level)) for level in ("immediate", "watch", "normal")}

    cross_tab: dict[str, dict[str, int]] = {
        h_level: {m_level: 0 for m_level in ("immediate", "watch", "normal")}
        for h_level in ("immediate", "watch", "normal")
    }
    for h_level, m_level in zip(heuristic_levels, model_levels):
        cross_tab[h_level][m_level] += 1

    mean_score_by_heuristic = {}
    for h_level in ("immediate", "watch", "normal"):
        mask = np.array(heuristic_levels) == h_level
        mean_score_by_heuristic[h_level] = float(np.mean(scores[mask])) if mask.any() else None

    model_immediate_mask = model_levels == "immediate"
    if model_immediate_mask.any():
        heuristic_arr = np.array(heuristic_levels)
        agrees_non_normal = np.mean(heuristic_arr[model_immediate_mask] != "normal")
    else:
        agrees_non_normal = None

    return {
        "holdout_size": len(issues),
        "model_level_counts": level_counts,
        "heuristic_level_counts": {
            level: heuristic_levels.count(level) for level in ("immediate", "watch", "normal")
        },
        "cross_tab_heuristic_rows_model_cols": cross_tab,
        "mean_anomaly_score_by_heuristic_level": mean_score_by_heuristic,
        "proxy_precision_model_immediate_vs_heuristic_non_normal": agrees_non_normal,
        "note": (
            "These are proxy agreement metrics against the pre-existing rule-based "
            "heuristic, not accuracy against a real escalation outcome label - none "
            "exists in this project. Lower anomaly score = more anomalous. Separation "
            "between heuristic buckets in mean_anomaly_score_by_heuristic_level is the "
            "main signal that the model's notion of 'unusual' tracks the heuristic's "
            "notion of 'risky'."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the escalation-risk anomaly model")
    parser.add_argument("--data", type=Path, default=REPO_ROOT / "ml" / "data" / "jira_export.jsonl")
    parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "ml" / "model")
    parser.add_argument("--holdout-fraction", type=float, default=0.15)
    parser.add_argument("--n-estimators", type=int, default=200)
    parser.add_argument("--contamination", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    print(f"Loading issues from {args.data}")
    issues = load_issues(args.data)
    print(f"Loaded {len(issues)} issues")

    rng = np.random.RandomState(args.seed)
    order = rng.permutation(len(issues))
    holdout_n = int(len(issues) * args.holdout_fraction)
    holdout_idx = set(order[:holdout_n].tolist())

    train_issues = [issue for i, issue in enumerate(issues) if i not in holdout_idx]
    holdout_issues = [issue for i, issue in enumerate(issues) if i in holdout_idx]
    print(f"Train: {len(train_issues)}  Holdout: {len(holdout_issues)}")

    X_train = np.array([compute_features(issue) for issue in train_issues], dtype=np.float32)
    X_holdout = np.array([compute_features(issue) for issue in holdout_issues], dtype=np.float32)

    print(f"Feature matrix shape: {X_train.shape} (features: {FEATURE_ORDER})")

    model = IsolationForest(
        n_estimators=args.n_estimators,
        contamination=args.contamination,
        random_state=args.seed,
        n_jobs=-1,
    )
    model.fit(X_train)

    train_scores = model.decision_function(X_train)
    immediate_threshold = float(np.percentile(train_scores, 10))
    watch_threshold = float(np.percentile(train_scores, 30))
    score_min = float(np.percentile(train_scores, 1))
    score_max = float(np.percentile(train_scores, 99))

    thresholds = {"immediate": immediate_threshold, "watch": watch_threshold}

    print("\n--- Evaluation on holdout set (proxy metrics vs. rule-based heuristic) ---")
    report = evaluate(model, X_holdout, holdout_issues, thresholds)
    print(json.dumps(report, indent=2))

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "eval_report.json").write_text(json.dumps(report, indent=2))

    onnx_model = convert_sklearn(
        model,
        initial_types=[("input", FloatTensorType([None, X_train.shape[1]]))],
        options={id(model): {"score_samples": True}},
        target_opset=TARGET_OPSET,
    )
    onnx_path = args.out_dir / "escalation_anomaly.onnx"
    onnx_path.write_bytes(onnx_model.SerializeToString())
    print(f"\nWrote ONNX model to {onnx_path} ({onnx_path.stat().st_size} bytes)")

    manifest = {
        "feature_order": FEATURE_ORDER,
        "immediate_keywords": IMMEDIATE_KEYWORDS,
        "watch_keywords": WATCH_KEYWORDS,
        "severity_rank_keywords": SEVERITY_RANK_KEYWORDS,
        "negative_tokens": sorted(NEGATIVE_TOKENS),
        "onnx_input_name": "input",
        "onnx_scores_output_name": "scores",
        "score_immediate_threshold": immediate_threshold,
        "score_watch_threshold": watch_threshold,
        "score_min": score_min,
        "score_max": score_max,
        "training": {
            "n_estimators": args.n_estimators,
            "contamination": args.contamination,
            "seed": args.seed,
            "train_size": len(train_issues),
            "holdout_size": len(holdout_issues),
        },
    }
    (args.out_dir / "feature_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Wrote feature manifest to {args.out_dir / 'feature_manifest.json'}")


if __name__ == "__main__":
    main()
