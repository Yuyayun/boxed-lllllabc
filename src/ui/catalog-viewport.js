// Scope visual-viewport tracking to the catalog; release all listeners on close.
export function trackCatalogViewport(dialog, view = globalThis.window) {
  if (!view) return () => {};
  const viewport = view.visualViewport;
  const update = () => {
    const bounds = { top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0,
      width: viewport?.width ?? view.innerWidth, height: viewport?.height ?? view.innerHeight };
    for (const [key, value] of Object.entries(bounds)) {
      if (Number.isFinite(value)) dialog.style.setProperty(`--boxed-lllllabc-catalog-viewport-${key}`, `${value}px`);
    }
  };
  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  view.addEventListener("resize", update);
  return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); view.removeEventListener("resize", update); };
}
