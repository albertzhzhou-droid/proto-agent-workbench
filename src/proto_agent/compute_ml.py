"""Bounded model-based analyses adapted from Biomni (deep VI and neural decoding).

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: GWAS tables arrive as JSON arrays instead of CSV files; the
torch model, ELBO, and Adam loop are transcribed as-is with fixed seeds; the
Kalman decoding keeps pykalman/sklearn but replaces file/pickle artifacts with
structured results. Both tools require their optional heavy dependencies.
"""

from __future__ import annotations

import math


def _numbers(value, name, minimum, maximum):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f"{name} must contain {minimum} to {maximum} numbers.")
    for index, item in enumerate(value):
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)) or abs(float(item)) > 1e100:
            raise ValueError(f"{name}[{index}] must be finite with magnitude <= 1e100.")
    return [float(item) for item in value]


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def bayesian_finemapping_with_deep_vi(arguments, files=None):
    """Torch transcription of upstream's VariationalFineMapping with a fixed seed."""
    variant_ids = arguments.get("variant_ids")
    z_scores = _numbers(arguments.get("z_scores"), "z_scores", 3, 500)
    if not isinstance(variant_ids, list) or len(variant_ids) != len(z_scores) or any(not isinstance(v, str) or not v for v in variant_ids):
        raise ValueError("variant_ids must be unique nonempty strings aligned with z_scores.")
    if len(set(variant_ids)) != len(variant_ids):
        raise ValueError("variant_ids must be unique.")
    n = len(z_scores)
    matrix = arguments.get("ld_matrix")
    if not isinstance(matrix, list) or len(matrix) != n or any(not isinstance(row, list) or len(row) != n for row in matrix):
        raise ValueError(f"ld_matrix must be {n}x{n} matching z_scores.")
    for row in matrix:
        for item in row:
            if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)) or abs(float(item)) > 1e6:
                raise ValueError("ld_matrix entries must be finite correlations.")
    hidden = int(arguments.get("hidden_dim", 32)) if isinstance(arguments.get("hidden_dim", 32), int) and not isinstance(arguments.get("hidden_dim", 32), bool) and 2 <= arguments.get("hidden_dim", 32) <= 256 else None
    if hidden is None:
        raise ValueError("hidden_dim must be an integer from 2 to 256.")
    iterations = int(arguments.get("iterations", 500)) if isinstance(arguments.get("iterations", 500), int) and not isinstance(arguments.get("iterations", 500), bool) and 10 <= arguments.get("iterations", 500) <= 5000 else None
    if iterations is None:
        raise ValueError("iterations must be an integer from 10 to 5000.")
    learning_rate = float(arguments.get("learning_rate", 0.01))
    if not (0 < learning_rate <= 1):
        raise ValueError("learning_rate must be in (0, 1].")
    credible_threshold = float(arguments.get("credible_threshold", 0.9))
    if not (0 < credible_threshold < 1):
        raise ValueError("credible_threshold must be between 0 and 1.")
    seed = int(arguments.get("seed", 0)) if isinstance(arguments.get("seed", 0), int) and not isinstance(arguments.get("seed", 0), bool) and 0 <= arguments.get("seed", 0) < 2**31 else None
    if seed is None:
        raise ValueError("seed must be an integer from 0 to 2147483647.")
    import torch
    from torch import nn, optim

    torch.manual_seed(seed)
    z = torch.tensor(z_scores, dtype=torch.float32)
    ld = torch.tensor(matrix, dtype=torch.float32)

    class VariationalFineMapping(nn.Module):
        def __init__(self, n_variants, hidden_dim):
            super().__init__()
            self.encoder = nn.Sequential(nn.Linear(n_variants, hidden_dim), nn.ReLU(),
                                         nn.Linear(hidden_dim, hidden_dim), nn.ReLU())
            self.log_alpha = nn.Linear(hidden_dim, n_variants)

        def forward(self, x):
            return torch.sigmoid(self.log_alpha(self.encoder(x)))

        def elbo_loss(self, z_scores_tensor, ld_tensor, pips, n_samples=10):
            samples = torch.bernoulli(pips.unsqueeze(0).repeat(n_samples, 1))
            prior_term = -0.01 * torch.sum(pips)
            likelihood_term = 0
            for sample in samples:
                expected_z = torch.matmul(ld_tensor, sample * z_scores_tensor)
                likelihood_term += -torch.sum((z_scores_tensor - expected_z) ** 2)
            likelihood_term /= n_samples
            return -(prior_term + likelihood_term)

    model = VariationalFineMapping(n, hidden)
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)
    losses = []
    for _iteration in range(iterations):
        optimizer.zero_grad()
        pips = model(z)
        loss = model.elbo_loss(z, ld, pips)
        loss.backward()
        optimizer.step()
        losses.append(float(loss.item()))
    with torch.no_grad():
        final_pips = model(z).numpy().tolist()
    ranked = sorted(zip(variant_ids, final_pips), key=lambda pair: -pair[1])
    cumulative = 0.0
    credible = []
    for identifier, pip in ranked:
        if cumulative >= credible_threshold and credible:
            break
        cumulative += pip
        credible.append({"variant_id": identifier, "pip": round(pip, 6), "cumulative_pip": round(cumulative, 6)})
    return {
        "variants": n, "iterations": iterations, "seed": seed, "hidden_dim": hidden,
        "initial_loss": round(losses[0], 4), "final_loss": round(losses[-1], 4),
        "top_variants": [{"variant_id": identifier, "pip": round(pip, 6)} for identifier, pip in ranked[:20]],
        "credible_set": credible,
        "method": "Upstream's two-layer variational encoder with Bernoulli ELBO and Adam, transcribed to torch with a fixed seed",
        "limitations": ["The ELBO's Gaussian-style likelihood over correlated z-scores is upstream's approximation, not a calibrated Bayesian fine-mapping posterior (compare SuSiE/FINEMAP before trusting PIPs).",
                        "PIPs are not guaranteed to sum to one; the credible set uses raw cumulative sums exactly as upstream.",
                        "The ELBO can collapse all PIPs toward zero on typical LD structure (one-hot inclusion increases the squared error); an empty or trivial credible set is a known upstream failure mode, not evidence of no causal variants.",
                        "Results depend on the supplied LD matrix quality; untested LD harmonization propagates directly."],
    }


def decode_behavior_from_neural_trajectories(arguments, files=None):
    """Upstream PCA + EM Kalman decoding with structured results."""
    neural = arguments.get("neural_data")
    behavior = arguments.get("behavioral_data")
    if not isinstance(neural, list) or not 10 <= len(neural) <= 5000:
        raise ValueError("neural_data must contain 10 to 5000 rows of firing-rate observations.")
    width = None
    for index, row in enumerate(neural):
        if not isinstance(row, list) or not 2 <= len(row) <= 500:
            raise ValueError(f"neural_data[{index}] must contain 2 to 500 unit rates.")
        if width is None:
            width = len(row)
        elif len(row) != width:
            raise ValueError("All neural_data rows must share the unit count.")
        for item in row:
            if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)) or abs(float(item)) > 1e100:
                raise ValueError(f"neural_data[{index}] entries must be finite numbers.")
    if not isinstance(behavior, list) or len(behavior) != len(neural):
        raise ValueError("behavioral_data must align with neural_data rows.")
    behavior_width = None
    for index, row in enumerate(behavior):
        if not isinstance(row, list) or not 1 <= len(row) <= 50:
            raise ValueError(f"behavioral_data[{index}] must contain 1 to 50 variables.")
        if behavior_width is None:
            behavior_width = len(row)
        elif len(row) != behavior_width:
            raise ValueError("All behavioral_data rows must share the variable count.")
    components = arguments.get("n_components", 10)
    if isinstance(components, bool) or not isinstance(components, int) or not 2 <= components <= min(50, width):
        raise ValueError(f"n_components must be an integer from 2 to {min(50, width)}.")
    test_fraction = float(arguments.get("test_fraction", 0.2))
    if not 0.1 <= test_fraction <= 0.5:
        raise ValueError("test_fraction must be between 0.1 and 0.5.")
    seed = arguments.get("seed", 42)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**31:
        raise ValueError("seed must be an integer from 0 to 2147483647.")
    import numpy as np
    from pykalman import KalmanFilter
    from sklearn.decomposition import PCA
    from sklearn.metrics import mean_squared_error
    from sklearn.model_selection import train_test_split

    x = np.nan_to_num(np.asarray(neural, dtype=float))
    y = np.nan_to_num(np.asarray(behavior, dtype=float))
    x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=test_fraction, random_state=seed, shuffle=False)
    pca = PCA(n_components=components)
    x_train_pca = pca.fit_transform(x_train)
    x_test_pca = pca.transform(x_test)
    explained = float(np.sum(pca.explained_variance_ratio_) * 100)
    kalman = KalmanFilter(initial_state_mean=np.zeros(y_train.shape[1]), n_dim_obs=x_train_pca.shape[1])
    kalman = kalman.em(x_train_pca, y_train)
    predicted, _filtered = kalman.filter(x_test_pca)
    mse = float(mean_squared_error(y_test, predicted))
    return {
        "samples": len(neural), "units": width, "behavior_variables": behavior_width,
        "train_samples": int(x_train.shape[0]), "test_samples": int(x_test.shape[0]),
        "n_components": components, "explained_variance_percent": round(explained, 4),
        "test_mse": round(mse, 6), "seed": seed,
        "predicted_sample": [[round(float(value), 6) for value in row] for row in predicted[:100]],
        "true_sample": [[round(float(value), 6) for value in row] for row in y_test[:100]],
        "method": "Temporal-order split, PCA trajectories, EM-fitted Kalman filter decoding (pykalman + sklearn, transcribed)",
        "limitations": ["Upstream used a shuffled split for time series; this port defaults to shuffle=False because shuffling leaks temporal autocorrelation into the MSE.",
                        "PCA is fitted on the training split only; the Kalman EM uses the upstream observation/state orientation.",
                        "MSE is scale-dependent; compare against a mean predictor before claiming decoding quality."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_NUMBERS = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 5000}


def _tool(title, description, schema, example, path, function, dependency):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": list(dependency), "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "bayesian_finemapping_with_deep_vi": _tool(
        "Deep-VI fine-mapping", "Train upstream's variational encoder on GWAS z-scores with an LD matrix and report PIPs and a credible set (torch).",
        _schema({"variant_ids": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 100}, "minItems": 3, "maxItems": 500},
                 "z_scores": _NUMBERS,
                 "ld_matrix": {"type": "array", "minItems": 3, "maxItems": 500, "items": {"type": "array", "minItems": 3, "maxItems": 500, "items": {"type": "number"}}},
                 "hidden_dim": {"type": "integer", "minimum": 2, "maximum": 256, "default": 32},
                 "iterations": {"type": "integer", "minimum": 10, "maximum": 5000, "default": 500},
                 "learning_rate": {"type": "number", "exclusiveMinimum": 0, "maximum": 1, "default": 0.01},
                 "credible_threshold": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1, "default": 0.9},
                 "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 0}},
                ["variant_ids", "z_scores", "ld_matrix"]),
        {"variant_ids": ["rs1", "rs2", "rs3", "rs4", "rs5"],
         "z_scores": [5.2, 4.9, 1.1, 0.8, 0.5],
         "ld_matrix": [[1.0, 0.9, 0.2, 0.1, 0.0], [0.9, 1.0, 0.1, 0.2, 0.1], [0.2, 0.1, 1.0, 0.8, 0.3],
                       [0.1, 0.2, 0.8, 1.0, 0.4], [0.0, 0.1, 0.3, 0.4, 1.0]],
         "iterations": 200, "seed": 0},
        "biomni/tool/genetics.py", "bayesian_finemapping_with_deep_vi", ("torch", "numpy")),
    "decode_behavior_from_neural_trajectories": _tool(
        "Neural trajectory decoding", "Fit PCA trajectories and an EM Kalman filter to decode behavioral variables from neural population activity.",
        _schema({"neural_data": {"type": "array", "minItems": 10, "maxItems": 5000, "items": {"type": "array", "minItems": 2, "maxItems": 500, "items": {"type": "number"}}},
                 "behavioral_data": {"type": "array", "minItems": 10, "maxItems": 5000, "items": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "number"}}},
                 "n_components": {"type": "integer", "minimum": 2, "maximum": 50, "default": 10},
                 "test_fraction": {"type": "number", "minimum": 0.1, "maximum": 0.5, "default": 0.2},
                 "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647, "default": 42}},
                ["neural_data", "behavioral_data"]),
        {"neural_data": [[0.2, 0.1, 0.4], [0.3, 0.1, 0.5], [0.4, 0.2, 0.6], [0.5, 0.2, 0.7], [0.6, 0.3, 0.8],
                         [0.7, 0.3, 0.9], [0.8, 0.4, 1.0], [0.9, 0.4, 1.1], [1.0, 0.5, 1.2], [1.1, 0.5, 1.3],
                         [1.2, 0.6, 1.4], [1.3, 0.6, 1.5], [1.4, 0.7, 1.6], [1.5, 0.7, 1.7], [1.6, 0.8, 1.8]],
         "behavioral_data": [[0.0], [0.1], [0.2], [0.3], [0.4], [0.5], [0.6], [0.7], [0.8], [0.9],
                             [1.0], [1.1], [1.2], [1.3], [1.4]],
         "n_components": 2},
        "biomni/tool/bioengineering.py", "decode_behavior_from_neural_trajectories", ("numpy", "sklearn", "pykalman")),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
