export const BARK_STANDARD_ID = 'ai-ecoverse/Underdog-Bark-3.0-ONNX';
export const BARK_MODEL_ID = 'velddev/Underdog-Bark-3.0-Plus-sherpa-onnx';
export const BARK_CLEAN_ID = 'velddev/Underdog-Bark-3.0-Clean-sherpa-onnx';
export const BARK_REVISION = '31f3aba9ddbe2825ea96938ef91742ad4a12d691';
export const BARK_MODELS = Object.freeze([
  { id: BARK_MODEL_ID, label: 'Bark 3.0 Plus · English verbatim', revision: '5f95a80a9da9d392a38df8e9a6609e25be643d07', layout: 'separate', clean: false, downloadNote: 'About 703 MB of model files. Preserves fillers and repeated words.' },
  { id: BARK_STANDARD_ID, label: 'Bark 3.0 · English verbatim', revision: BARK_REVISION, layout: 'joint', clean: false, downloadNote: 'About 524 MB with graphics acceleration, or 911 MB for CPU compatibility. Preserves fillers and repeated words.' },
  { id: BARK_CLEAN_ID, label: 'Bark 3.0 Clean · edited transcript', revision: 'bdcbdca05592e01e075a7a0179fe57ef0ccb50d5', layout: 'separate', clean: true, downloadNote: 'About 703 MB of model files. Removes fillers and false starts, so those statistics will undercount your speech.' },
]);
export const BARK_MODEL_LABEL = BARK_MODELS[0].label;
export const isBarkModel = model => BARK_MODELS.some(entry => entry.id === model);
