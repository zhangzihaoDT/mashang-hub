// Shared by Web and CLI: keep a valid selection, then use the Web default.
export function selectAvailableModel(models, preferred) {
  const available = models.filter(model => model.available && model.providerID && model.modelID);
  return available.find(model => preferred && ((preferred.key && model.key === preferred.key) ||
    model.providerID === preferred.providerID && model.modelID === preferred.modelID)) ||
    available.find(model => model.key === 'deepseek') || available[0] || null;
}
