/** Apply an accent and readable text for its normal and shaded action surfaces.
 * Kept self-contained so Layout can run this same function before first paint.
 */
export function applyPersonalAccent(root: HTMLElement, color: string | null): void {
  const properties = ["--personal-accent", "--personal-accent-foreground", "--personal-accent-hover-foreground"]
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
    for (const property of properties) root.style.removeProperty(property)
    return
  }
  function foreground(shade: number): string {
    const channels = color!.slice(1).match(/../g)!.map(pair => parseInt(pair, 16) / 255 * shade)
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff"
  }
  root.style.setProperty(properties[0]!, color)
  root.style.setProperty(properties[1]!, foreground(1))
  // The existing personal hover is 85% accent; the action hover shades it by 95%.
  root.style.setProperty(properties[2]!, foreground(0.85 * 0.95))
}
