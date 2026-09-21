// Preserve actionable failure evidence without copying a full relationship graph.
export function compactPreparationError(error) {
  const shorten = (text, limit = 800) => String(text ?? '').slice(0, limit);
  const details = Array.isArray(error?.details) ? error.details : [];
  const diagnostics = error?.review?.diagnostics ?? error?.details?.review?.diagnostics ?? [];
  return {
    status: 'error', error: shorten(error?.message ?? error), code: shorten(error?.code ?? 'plan-prepare-failed', 100),
    validationPhase: error?.review?.validationPhase ?? null,
    messages: [...new Set(details.filter((v) => typeof v === 'string').map((v) => shorten(v)))].slice(0, 8),
    diagnostics: [...new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => JSON.stringify({
      code: shorten(d.code, 100), message: shorten(d.message), opId: d.opId ? shorten(d.opId, 100) : undefined,
    })))].slice(0, 8).map(JSON.parse),
  };
}
