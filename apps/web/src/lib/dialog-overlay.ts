export function mountDialogOverlay(overlay: HTMLElement): void {
  document.body.append(overlay)
  if (typeof overlay.showPopover !== "function" || !document.querySelector("[popover]:popover-open")) return
  // A popover is already in the top layer. A body-mounted overlay needs to sit above it.
  overlay.setAttribute("popover", "manual")
  Object.assign(overlay.style, {
    margin: "0", border: "0", padding: "0", width: "auto", height: "auto", maxWidth: "none", maxHeight: "none",
  })
  overlay.showPopover()
}
