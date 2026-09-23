export function hasResult(task) {
  return Boolean(task?.hasText || task?.artifactCount > 0);
}
