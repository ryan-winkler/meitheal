/** Apply an accent and readable text for its normal and shaded action surfaces.
 * Kept self-contained so Layout can run this same function before first paint.
 */
export function applyPersonalAccent(root: HTMLElement, color: string | null): void {
  const properties = [
    "--personal-accent",
    "--personal-accent-foreground",
    "--personal-accent-hover-foreground",
    "--personal-accent-rgb",
    "--personal-accent-text-dark",
    "--personal-accent-text-light",
  ]
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
    for (const property of properties) root.style.removeProperty(property)
    return
  }
  const rgb = color.slice(1).match(/../g)!.map(pair => parseInt(pair, 16))
  function luminanceOf(channels: number[]): number {
    const linear = channels.map(channel => {
      const value = Math.max(0, Math.min(255, channel)) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  function contrastRatio(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  function toHex(channels: number[]): string {
    return `#${channels.map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`
  }
  function tuneForSurface(surfaceLuminance: number, targetRgb: number[]): string {
    for (let step = 0; step <= 10; step++) {
      const t = step / 10
      const mixed = rgb.map((c, idx) => c + (targetRgb[idx]! - c) * t)
      if (contrastRatio(luminanceOf(mixed), surfaceLuminance) >= 4.8) return toHex(mixed)
    }
    return toHex(targetRgb)
  }
  function foreground(shade: number): string {
    const lum = luminanceOf(rgb.map(channel => channel * shade))
    return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? "#000000" : "#ffffff"
  }
  root.style.setProperty(properties[0]!, color)
  root.style.setProperty(properties[1]!, foreground(1))
  // The existing personal hover is 85% accent; the action hover shades it by 95%.
  root.style.setProperty(properties[2]!, foreground(0.85 * 0.95))
  root.style.setProperty(properties[3]!, `${rgb[0]} ${rgb[1]} ${rgb[2]}`)
  root.style.setProperty(properties[4]!, tuneForSurface(0.015, [245, 247, 246]))
  root.style.setProperty(properties[5]!, tuneForSurface(1, [16, 24, 20]))
}
