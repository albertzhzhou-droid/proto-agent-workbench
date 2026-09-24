"""Bounded medical-image registration and NIfTI analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: SimpleITK/nibabel load workspace bytes through private
temporary files (no host-path orchestration); registered images, transform
files, and PNG visualizations are not written — structured summaries,
transform parameters, and similarity metrics are returned instead; the nnUNet
runner itself stays deferred (trained-model download) while its modality
splitting and input preparation become data-shape tools.
"""

from __future__ import annotations

import math
import tempfile
from pathlib import Path


def _number(value, name, *, minimum=None, maximum=None, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1e100:
        raise ValueError(f"{name} must be finite with magnitude <= 1e100.")
    if positive and result <= 0:
        raise ValueError(f"{name} must be positive.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise ValueError(f"{name} is outside its allowed range.")
    return result


def _sitk_read(raw, label):
    import SimpleITK as sitk

    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as handle:
        handle.write(raw)
        temporary = Path(handle.name)
    try:
        image = sitk.ReadImage(str(temporary))
    except RuntimeError as error:
        raise ValueError(f"{label} could not be read as a medical image: {error}.") from None
    finally:
        temporary.unlink()
    if image.GetDimension() not in (2, 3):
        raise ValueError(f"{label} must be a 2D or 3D image.")
    pixels = sitk.GetArrayFromImage(image)
    if pixels.size > 40_000_000:
        raise ValueError(f"{label} exceeds the 40-million-voxel offline limit.")
    return image


def _nib_read(raw, label):
    import nibabel as nib
    import numpy as np

    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as handle:
        handle.write(raw)
        temporary = Path(handle.name)
    try:
        image = nib.load(str(temporary))
        data = np.asarray(image.dataobj, dtype=np.float64)
    except Exception as error:
        raise ValueError(f"{label} could not be read as a NIfTI image: {error}.") from None
    finally:
        temporary.unlink()
    if data.size > 40_000_000:
        raise ValueError(f"{label} exceeds the 40-million-voxel offline limit.")
    return image, data


def _similarity(fixed_array, moving_array):
    import numpy as np

    flat_fixed = fixed_array.flatten()
    flat_moving = moving_array.flatten()
    valid = np.isfinite(flat_fixed) & np.isfinite(flat_moving)
    flat_fixed, flat_moving = flat_fixed[valid], flat_moving[valid]
    if flat_fixed.size == 0:
        return {"mutual_information": 0.0, "mean_squares": 0.0, "correlation": 0.0, "normalized_correlation": 0.0}
    mse = float(np.mean((flat_fixed - flat_moving) ** 2))
    correlation = 0.0
    if np.std(flat_fixed) > 0 and np.std(flat_moving) > 0:
        value = float(np.corrcoef(flat_fixed, flat_moving)[0, 1])
        correlation = value if not math.isnan(value) else 0.0
    histogram, _x, _y = np.histogram2d(flat_fixed, flat_moving, bins=50)
    histogram = histogram + 1e-10
    joint = histogram / histogram.sum()
    px, py = joint.sum(axis=1), joint.sum(axis=0)
    mutual = float(sum(joint[i, j] * math.log2(joint[i, j] / (px[i] * py[j]))
                       for i in range(len(px)) for j in range(len(py)) if joint[i, j] > 0))
    return {"mutual_information": round(mutual, 6), "mean_squares": round(-mse, 6),
            "correlation": round(correlation, 6), "normalized_correlation": round(correlation, 6)}


def _registration(arguments, files, kind):
    import SimpleITK as sitk

    fixed = _sitk_read(files["fixed_image_path"], "fixed_image_path")
    moving = _sitk_read(files["moving_image_path"], "moving_image_path")
    metric = arguments.get("metric", "mutual_information")
    if metric not in ("mutual_information", "mean_squares", "correlation", "normalized_correlation"):
        raise ValueError("metric must be mutual_information, mean_squares, correlation, or normalized_correlation.")
    optimizer = arguments.get("optimizer", "gradient_descent")
    if optimizer not in ("gradient_descent", "lbfgsb", "powell", "amoeba"):
        raise ValueError("optimizer must be gradient_descent, lbfgsb, powell, or amoeba.")
    learning_rate = _number(arguments.get("learning_rate", 1.0), "learning_rate", positive=True, maximum=1e6)
    iterations = int(arguments.get("number_of_iterations", 100)) if isinstance(arguments.get("number_of_iterations", 100), int) and not isinstance(arguments.get("number_of_iterations", 100), bool) and 1 <= arguments.get("number_of_iterations", 100) <= 2000 else None
    if iterations is None:
        raise ValueError("number_of_iterations must be an integer from 1 to 2000.")
    tolerance = _number(arguments.get("gradient_convergence_tolerance", 1e-6), "gradient_convergence_tolerance", minimum=1e-12, maximum=1.0)
    if kind == "rigid":
        transform = sitk.Euler3DTransform() if fixed.GetDimension() == 3 else sitk.Euler2DTransform()
    elif kind == "affine":
        transform = sitk.AffineTransform(fixed.GetDimension())
    else:
        control = int(arguments.get("number_of_control_points", 8)) if isinstance(arguments.get("number_of_control_points", 8), int) and not isinstance(arguments.get("number_of_control_points", 8), bool) and 3 <= arguments.get("number_of_control_points", 8) <= 30 else None
        if control is None:
            raise ValueError("number_of_control_points must be an integer from 3 to 30.")
        if fixed.GetDimension() != 3:
            raise ValueError("Deformable BSpline registration requires 3D images.")
        transform = sitk.BSplineTransformInitializer(fixed, [control] * 3, order=3)
    # Upstream left transforms at the corner origin, coupling rotation into
    # translation; initialize geometry centers instead.
    if kind in ("rigid", "affine"):
        transform = sitk.CenteredTransformInitializer(fixed, moving, transform,
                                                      sitk.CenteredTransformInitializerFilter.GEOMETRY)
    method = sitk.ImageRegistrationMethod()
    if metric == "mutual_information":
        method.SetMetricAsMattesMutualInformation(numberOfHistogramBins=50)
    elif metric == "mean_squares":
        method.SetMetricAsMeanSquares()
    elif metric == "correlation":
        method.SetMetricAsCorrelation()
    else:
        method.SetMetricAsNormalizedCorrelation()
    if optimizer == "gradient_descent":
        method.SetOptimizerAsGradientDescent(learningRate=learning_rate, numberOfIterations=iterations, convergenceMinimumValue=tolerance)
    elif optimizer == "lbfgsb":
        method.SetOptimizerAsLBFGSB(gradientConvergenceTolerance=tolerance, numberOfIterations=iterations)
    elif optimizer == "powell":
        method.SetOptimizerAsPowell(numberOfIterations=iterations, maximumLineIterations=20)
    else:
        method.SetOptimizerAsAmoeba(numberOfIterations=iterations, parametersConvergenceTolerance=tolerance)
    method.SetInterpolator(sitk.sitkLinear)
    method.SetInitialTransform(transform, inPlace=False)
    final = method.Execute(fixed, moving)
    resampler = sitk.ResampleImageFilter()
    resampler.SetReferenceImage(fixed)
    resampler.SetInterpolator(sitk.sitkLinear)
    resampler.SetDefaultPixelValue(0)
    resampler.SetTransform(final)
    registered = resampler.Execute(moving)
    before = _similarity(sitk.GetArrayFromImage(fixed), sitk.GetArrayFromImage(moving))
    after = _similarity(sitk.GetArrayFromImage(fixed), sitk.GetArrayFromImage(registered))
    return {"registration_type": kind, "metric": metric, "optimizer": optimizer, "iterations": iterations,
            "final_metric_value": round(float(method.GetMetricValue()), 6),
            "optimizer_iteration": int(method.GetOptimizerIteration()),
            "stop_condition": method.GetOptimizerStopConditionDescription(),
            "transform_parameters": [round(float(v), 6) for v in final.GetParameters()],
            "metrics_before": before, "metrics_after": after,
            "fixed_size": list(fixed.GetSize()), "moving_size": list(moving.GetSize()),
            "method": f"SimpleITK {kind} registration with geometry-centered initialization (upstream corner-origin defect corrected)",
            "limitations": ["Registered images and .tfm files that upstream wrote are not produced; transform parameters are returned for inspection.",
                            "Metric improvement does not certify anatomical correctness; inspect the stop condition and overlay externally."]}


def quick_rigid_registration(arguments, files):
    return _registration(arguments, files, "rigid")


def quick_affine_registration(arguments, files):
    return _registration(arguments, files, "affine")


def quick_deformable_registration(arguments, files):
    return _registration(arguments, files, "deformable")


def batch_register_images(arguments, files):
    moving = files.get("moving_image_paths")
    if not isinstance(moving, list) or not 1 <= len(moving) <= 10:
        raise ValueError("moving_image_paths must resolve to 1 to 10 images.")
    kind = arguments.get("transform_type", "rigid")
    if kind not in ("rigid", "affine", "deformable"):
        raise ValueError("transform_type must be rigid, affine, or deformable.")
    fixed_bytes = files.get("fixed_image_path")
    results = []
    for index, blob in enumerate(moving):
        try:
            result = _registration({**arguments, "transform_type": kind},
                                   {"fixed_image_path": fixed_bytes, "moving_image_path": blob}, kind)
            result["image_index"] = index
            results.append(result)
        except ValueError as error:
            results.append({"image_index": index, "error": str(error)[:300]})
    return {"registration_type": kind, "image_count": len(moving),
            "results": results,
            "method": "Sequential per-image registration against the shared reference (upstream batch loop without directory iteration)",
            "limitations": ["Upstream scanned an output directory of images; this port registers an explicit list of workspace files.",
                            "Per-image failures are reported inline exactly as upstream collected them into a results dict."]}


def calculate_similarity_metrics(arguments, files):
    import SimpleITK as sitk

    first = _sitk_read(files["image1_path"], "image1_path")
    second = _sitk_read(files["image2_path"], "image2_path")
    if first.GetSize() != second.GetSize():
        raise ValueError("Both images must share the same geometry for voxel-wise similarity.")
    return {**_similarity(sitk.GetArrayFromImage(first), sitk.GetArrayFromImage(second)),
            "image_size": list(first.GetSize()),
            "method": "Histogram mutual information, negative MSE, and Pearson correlation over finite voxels (upstream transcription)",
            "limitations": ["Voxel-wise metrics ignore interpolation and intensity-scaling differences inherent to cross-modality images."]}


def preprocess_image(arguments, files):
    import SimpleITK as sitk

    image = _sitk_read(files["image_path"], "image_path")
    denoise = bool(arguments.get("denoise", True))
    normalize = bool(arguments.get("normalize", True))
    processed = sitk.Image(image)
    if denoise:
        processed = sitk.SmoothingRecursiveGaussian(processed, sigma=1.0)
    if normalize:
        minimum_maximum = sitk.MinimumMaximumImageFilter()
        minimum_maximum.Execute(processed)
        low, high = minimum_maximum.GetMinimum(), minimum_maximum.GetMaximum()
        if high > low:
            processed = sitk.IntensityWindowing(processed, windowMinimum=low, windowMaximum=high, outputMinimum=0.0, outputMaximum=1.0)
    before, after = sitk.GetArrayFromImage(image), sitk.GetArrayFromImage(processed)
    return {"denoise": denoise, "normalize": normalize, "size": list(image.GetSize()),
            "original_range": [round(float(before.min()), 6), round(float(before.max()), 6)],
            "processed_range": [round(float(after.min()), 6), round(float(after.max()), 6)],
            "processed_preview": [[round(float(v), 4) for v in row] for row in after.reshape(-1, after.shape[-1])[:8]],
            "method": "SimpleITK recursive-Gaussian smoothing and min-max intensity windowing (upstream preprocess_image)",
            "limitations": ["The processed volume stays in memory; upstream wrote it to disk for nnUNet pipelines."]}


def split_modalities(arguments, files):
    _image, data = _nib_read(files["mri_path"], "mri_path")
    if data.ndim != 4 or data.shape[-1] != 4:
        raise ValueError("Expected a 4D NIfTI with exactly four modalities in the last dimension.")
    names = ["FLAIR", "T1w", "t1gd", "T2w"]
    summary = []
    for index, name in enumerate(names):
        volume = data[..., index]
        summary.append({"modality": name, "shape": list(volume.shape),
                        "min": round(float(volume.min()), 6), "max": round(float(volume.max()), 6),
                        "mean": round(float(volume.mean()), 6), "std": round(float(volume.std()), 6)})
    return {"modalities": summary, "volume_shape": list(data.shape),
            "method": "Last-axis 4D NIfTI modality split (upstream split_modalities without per-file writes)",
            "limitations": ["Upstream saved four .nii.gz files; this port reports per-modality statistics and shapes for verification."]}


def prepare_input_for_nnunet(arguments, files):
    _image, data = _nib_read(files["mri_path"], "mri_path")
    if data.ndim == 4 and data.shape[-1] == 4:
        return split_modalities(arguments, files)
    if data.ndim == 3:
        return {"input_kind": "single 3D volume", "shape": list(data.shape),
                "min": round(float(data.min()), 6), "max": round(float(data.max()), 6),
                "method": "3D NIfTI accepted as a single-channel nnUNet input (upstream copy step without file writes)",
                "limitations": ["Channel-named _0000 files that upstream staged are not written; feed the volume to your nnUNet pipeline manually."]}
    raise ValueError("nnUNet input must be a 3D volume or a 4D file with four modalities.")


def create_segmentation_visualization(arguments, files):
    _reference, reference = _nib_read(files["mri_path"], "mri_path")
    _segmentation, segmentation = _nib_read(files["segmentation_path"], "segmentation_path")
    if reference.shape != segmentation.shape:
        raise ValueError("The MRI volume and segmentation must share one grid.")
    labels = sorted(int(value) for value in numpy_unique_nonzero(segmentation))
    overlay = []
    middle = reference.shape[0] // 2 if reference.ndim == 3 else 0
    slice_grid = (reference[middle] if reference.ndim == 3 else reference)
    mask_grid = (segmentation[middle] if segmentation.ndim == 3 else segmentation)
    overlay = [[round(float(slice_grid[i, j]), 4) if mask_grid[i, j] else None
                for j in range(0, slice_grid.shape[1], max(1, slice_grid.shape[1] // 24))]
               for i in range(0, slice_grid.shape[0], max(1, slice_grid.shape[0] // 24))]
    return {"labels": labels[:50], "middle_slice": int(middle),
            "label_volume": {int(value): int((segmentation == value).sum()) for value in labels[:10]},
            "intensity_grid_under_mask": overlay,
            "method": "Label census plus a sparse middle-slice intensity grid under the mask (nilearn PNG rendering replaced by structured data)",
            "limitations": ["Upstream rendered PNG overlays with nilearn; figures must be regenerated externally if needed."]}


def numpy_unique_nonzero(array):
    import numpy as np

    return np.unique(array[array != 0])


def reconstruct_3d_face_from_mri(arguments, files):
    import numpy as np
    import SimpleITK as sitk
    from skimage import measure

    _image, volume = _nib_read(files["mri_path"], "mri_path")
    if volume.ndim != 3:
        raise ValueError("The MRI volume must be 3D.")
    threshold = _number(arguments.get("threshold_value", 0.5), "threshold_value", minimum=0, maximum=1)
    low, high = float(volume.min()), float(volume.max())
    normalized = (volume - low) / (high - low) if high > low else np.zeros_like(volume)
    sitk_image = sitk.GetImageFromArray(normalized.astype(np.float32))
    smoothed = sitk.GetArrayFromImage(sitk.CurvatureFlow(image1=sitk_image, timeStep=0.125, numberOfIterations=5))
    mask = smoothed > threshold
    cleaned = sitk.GetArrayFromImage(sitk.BinaryOpeningByReconstruction(sitk.GetImageFromArray(mask.astype(np.uint8)), [3, 3, 3])) > 0
    if not cleaned.any():
        raise ValueError("The threshold produced an empty surface; lower threshold_value.")
    vertices, faces, _normals, _values = measure.marching_cubes(cleaned.astype(np.float32), level=0.5)
    neighbors = {}
    for triangle in faces[:200000].astype(int):
        for a, b in ((triangle[0], triangle[1]), (triangle[1], triangle[2]), (triangle[0], triangle[2])):
            neighbors.setdefault(a, set()).add(b)
            neighbors.setdefault(b, set()).add(a)
    degrees = [len(neighbors.get(index, ())) for index in range(len(vertices))]
    surface = float(sum(0.5 * np.linalg.norm(np.cross(vertices[t[1]] - vertices[t[0]], vertices[t[2]] - vertices[t[0]]))
                        for t in faces[:200000].astype(int)))
    return {"volume_shape": list(volume.shape), "threshold": threshold,
            "vertices": int(len(vertices)), "faces": int(len(faces)),
            "mean_degree": round(float(np.mean(degrees)), 4),
            "bounding_box": [[round(float(v), 4) for v in vertices.min(axis=0)], [round(float(v), 4) for v in vertices.max(axis=0)]],
            "surface_area_voxels2": round(surface, 4),
            "method": "Curvature-flow smoothing, morphological opening, and marching cubes (upstream pipeline with mesh statistics instead of file export)",
            "limitations": ["Upstream exported .stl/.obj meshes; this port reports mesh statistics. The threshold is normalized-intensity based and anatomically unvalidated."]}


def calculate_brain_adc_map(arguments, files):
    import nibabel as nib
    import numpy as np
    from scipy.optimize import curve_fit

    _image, dwi = _nib_read(files["dwi_path"], "dwi_path")
    if dwi.ndim != 4:
        raise ValueError("The DWI series must be 4D (x, y, z, b-value).")
    b_values = arguments.get("b_values")
    if (not isinstance(b_values, list) or len(b_values) != dwi.shape[3]
            or any(isinstance(b, bool) or not isinstance(b, (int, float)) or float(b) < 0 for b in b_values)):
        raise ValueError("b_values must be nonnegative numbers, one per volume.")
    b_values = np.asarray([float(b) for b in b_values])
    baseline = int(np.argmin(b_values))
    if b_values[baseline] != 0:
        raise ValueError("One b-value must be 0 for the baseline volume.")
    mask = dwi[..., baseline] > dwi[..., baseline].mean() * 0.1

    def mono_exponential(b, s0, adc):
        return s0 * np.exp(-b * adc)

    shape = dwi.shape[:3]
    adc_map = np.zeros(shape)
    coordinates = np.argwhere(mask)
    for x, y, z in coordinates:
        signal = dwi[x, y, z, :]
        if np.any(signal <= 0) or len(np.unique(signal)) < 2:
            continue
        try:
            parameters, _covariance = curve_fit(mono_exponential, b_values, signal, p0=[signal.max(), 0.001],
                                                bounds=([0, 0], [np.inf, 0.01]), maxfev=2000)
            adc_map[x, y, z] = parameters[1]
        except (RuntimeError, ValueError):
            continue
    valid = adc_map[mask & (adc_map > 0)]
    if valid.size == 0:
        raise ValueError("No voxels produced a finite ADC; check b-values and signal scaling.")
    return {"shape": list(shape), "b_values": [float(b) for b in b_values], "masked_voxels": int(mask.sum()),
            "fitted_voxels": int(valid.size),
            "adc_stats_mm2_per_s": {"mean": round(float(valid.mean()), 8), "median": round(float(np.median(valid)), 8),
                                    "min": round(float(valid.min()), 8), "max": round(float(valid.max()), 8),
                                    "std": round(float(valid.std()), 8)},
            "adc_map_preview": [[round(float(adc_map[i, j, adc_map.shape[2] // 2]), 8) for j in range(0, shape[1], max(1, shape[1] // 16))]
                                for i in range(0, shape[0], max(1, shape[0] // 16))],
            "method": "Per-voxel monoexponential S(b) = S0 exp(-b ADC) fits with an automatic baseline-threshold mask (upstream transcription)",
            "limitations": ["Voxels with nonpositive or constant signal are skipped exactly as upstream zeroed them.",
                            "The ADC NIfTI that upstream saved is not written; a sparse middle-slice preview is returned instead.",
                            "Units follow your b-value scaling; validate against scanner software before clinical use."]}


_NIFTI = {"extensions": [".nii", ".gz", ".nii.gz"], "max_bytes": 256 * 1024 * 1024}
_IMAGE_PAIR = {"fixed_image_path": _NIFTI, "moving_image_path": _NIFTI}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, dependency=("numpy", "scipy", "SimpleITK"), file_inputs=None):
    entry = {"title": title, "description": description, "input_schema": schema, "example": example,
             "dependency": list(dependency), "implementation": "biomni-adapted",
             "upstream_functions": [{"path": path, "name": function}]}
    if file_inputs:
        entry["file_inputs"] = file_inputs
    return entry


_TOOLS = {
    "quick_rigid_registration": _tool(
        "Rigid registration", "Register a moving medical image to a reference with a rigid transform and report metrics before and after.",
        _schema({"fixed_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "moving_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "metric": {"type": "string", "enum": ["mutual_information", "mean_squares", "correlation", "normalized_correlation"], "default": "mutual_information"},
                 "optimizer": {"type": "string", "enum": ["gradient_descent", "lbfgsb", "powell", "amoeba"], "default": "gradient_descent"},
                 "learning_rate": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 1.0},
                 "number_of_iterations": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 100},
                 "gradient_convergence_tolerance": {"type": "number", "minimum": 1e-12, "maximum": 1, "default": 1e-6}},
                ["fixed_image_path", "moving_image_path"]),
        {"fixed_image_path": "build/compute-inputs/reference.nii.gz", "moving_image_path": "build/compute-inputs/moving.nii.gz",
         "number_of_iterations": 30},
        "biomni/tool/bioimaging.py", "quick_rigid_registration", file_inputs=_IMAGE_PAIR),
    "quick_affine_registration": _tool(
        "Affine registration", "Register a moving medical image to a reference with an affine transform and report metrics before and after.",
        _schema({"fixed_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "moving_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "metric": {"type": "string", "enum": ["mutual_information", "mean_squares", "correlation", "normalized_correlation"], "default": "mutual_information"},
                 "optimizer": {"type": "string", "enum": ["gradient_descent", "lbfgsb", "powell", "amoeba"], "default": "gradient_descent"},
                 "learning_rate": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 1.0},
                 "number_of_iterations": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 100},
                 "gradient_convergence_tolerance": {"type": "number", "minimum": 1e-12, "maximum": 1, "default": 1e-6}},
                ["fixed_image_path", "moving_image_path"]),
        {"fixed_image_path": "build/compute-inputs/reference.nii.gz", "moving_image_path": "build/compute-inputs/moving.nii.gz",
         "number_of_iterations": 30},
        "biomni/tool/bioimaging.py", "quick_affine_registration", file_inputs=_IMAGE_PAIR),
    "quick_deformable_registration": _tool(
        "Deformable BSpline registration", "Register a 3D moving image with a BSpline deformable transform and report metrics before and after.",
        _schema({"fixed_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "moving_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "metric": {"type": "string", "enum": ["mutual_information", "mean_squares", "correlation", "normalized_correlation"], "default": "mutual_information"},
                 "optimizer": {"type": "string", "enum": ["gradient_descent", "lbfgsb", "powell", "amoeba"], "default": "gradient_descent"},
                 "learning_rate": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 1.0},
                 "number_of_iterations": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 100},
                 "gradient_convergence_tolerance": {"type": "number", "minimum": 1e-12, "maximum": 1, "default": 1e-6},
                 "number_of_control_points": {"type": "integer", "minimum": 3, "maximum": 30, "default": 8}},
                ["fixed_image_path", "moving_image_path"]),
        {"fixed_image_path": "build/compute-inputs/reference.nii.gz", "moving_image_path": "build/compute-inputs/moving.nii.gz",
         "number_of_iterations": 20, "number_of_control_points": 5},
        "biomni/tool/bioimaging.py", "quick_deformable_registration", file_inputs=_IMAGE_PAIR),
    "batch_register_images": _tool(
        "Batch registration", "Register a list of moving images against one shared reference with a rigid, affine, or deformable transform.",
        _schema({"fixed_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "moving_image_paths": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"type": "string", "minLength": 1, "maxLength": 400}},
                 "transform_type": {"type": "string", "enum": ["rigid", "affine", "deformable"], "default": "rigid"},
                 "metric": {"type": "string", "enum": ["mutual_information", "mean_squares", "correlation", "normalized_correlation"], "default": "mutual_information"},
                 "optimizer": {"type": "string", "enum": ["gradient_descent", "lbfgsb", "powell", "amoeba"], "default": "gradient_descent"},
                 "number_of_iterations": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 100}},
                ["fixed_image_path", "moving_image_paths"]),
        {"fixed_image_path": "build/compute-inputs/reference.nii.gz",
         "moving_image_paths": ["build/compute-inputs/moving.nii.gz", "build/compute-inputs/moving2.nii.gz"],
         "transform_type": "rigid", "number_of_iterations": 20},
        "biomni/tool/bioimaging.py", "batch_register_images",
        file_inputs={"fixed_image_path": _NIFTI, "moving_image_paths": {**_NIFTI, "list": True, "max_files": 10}}),
    "calculate_similarity_metrics": _tool(
        "Image similarity metrics", "Compare two same-geometry medical images with mutual information, MSE, and correlation.",
        _schema({"image1_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "image2_path": {"type": "string", "minLength": 1, "maxLength": 400}}, ["image1_path", "image2_path"]),
        {"image1_path": "build/compute-inputs/reference.nii.gz", "image2_path": "build/compute-inputs/moving.nii.gz"},
        "biomni/tool/bioimaging.py", "calculate_similarity_metrics",
        file_inputs={"image1_path": _NIFTI, "image2_path": _NIFTI}),
    "preprocess_image": _tool(
        "Medical image preprocessing", "Apply recursive-Gaussian denoising and min-max normalization to a medical image volume.",
        _schema({"image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "denoise": {"type": "boolean", "default": True},
                 "normalize": {"type": "boolean", "default": True}}, ["image_path"]),
        {"image_path": "build/compute-inputs/reference.nii.gz"},
        "biomni/tool/bioimaging.py", "preprocess_image", file_inputs={"image_path": _NIFTI}),
    "split_modalities": _tool(
        "MRI modality split", "Split a four-modality 4D NIfTI into per-modality shape and intensity summaries (nnUNet staging step).",
        _schema({"mri_path": {"type": "string", "minLength": 1, "maxLength": 400}}, ["mri_path"]),
        {"mri_path": "build/compute-inputs/fourmod.nii.gz"},
        "biomni/tool/bioimaging.py", "split_modalities", dependency=("numpy", "nibabel"), file_inputs={"mri_path": _NIFTI}),
    "prepare_input_for_nnunet": _tool(
        "nnUNet input preparation", "Validate and summarize a NIfTI for nnUNet consumption, splitting four-modality files when present.",
        _schema({"mri_path": {"type": "string", "minLength": 1, "maxLength": 400}}, ["mri_path"]),
        {"mri_path": "build/compute-inputs/fourmod.nii.gz"},
        "biomni/tool/bioimaging.py", "prepare_input_for_nnunet", dependency=("numpy", "nibabel"), file_inputs={"mri_path": _NIFTI}),
    "create_segmentation_visualization": _tool(
        "Segmentation overlay summary", "Summarize label volumes and a sparse masked-intensity grid in place of nilearn PNG rendering.",
        _schema({"mri_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "segmentation_path": {"type": "string", "minLength": 1, "maxLength": 400}}, ["mri_path", "segmentation_path"]),
        {"mri_path": "build/compute-inputs/reference.nii.gz", "segmentation_path": "build/compute-inputs/segmentation.nii.gz"},
        "biomni/tool/bioimaging.py", "create_segmentation_visualization",
        dependency=("numpy", "nibabel"), file_inputs={"mri_path": _NIFTI, "segmentation_path": _NIFTI}),
    "reconstruct_3d_face_from_mri": _tool(
        "3D face surface reconstruction", "Threshold and smooth a head MRI into a marching-cubes surface with mesh statistics.",
        _schema({"mri_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "threshold_value": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5}}, ["mri_path"]),
        {"mri_path": "build/compute-inputs/head.nii.gz", "threshold_value": 0.4},
        "biomni/tool/physiology.py", "reconstruct_3d_face_from_mri",
        dependency=("numpy", "scipy", "SimpleITK", "skimage", "nibabel"), file_inputs={"mri_path": _NIFTI}),
    "calculate_brain_adc_map": _tool(
        "Brain ADC map", "Fit per-voxel monoexponential diffusion decays from a 4D DWI series and report ADC statistics.",
        _schema({"dwi_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "b_values": {"type": "array", "minItems": 2, "maxItems": 20, "items": {"type": "number", "minimum": 0}}},
                ["dwi_path", "b_values"]),
        {"dwi_path": "build/compute-inputs/dwi.nii.gz", "b_values": [0, 1000]},
        "biomni/tool/physiology.py", "calculate_brain_adc_map",
        dependency=("numpy", "scipy", "nibabel"), file_inputs={"dwi_path": _NIFTI}),
}
TOOLS = _TOOLS
HANDLERS = {name: globals()[name] for name in TOOLS}
