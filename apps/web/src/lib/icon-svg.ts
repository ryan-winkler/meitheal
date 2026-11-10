import DOMPurify from "dompurify"

/** Sanitize uploaded SVG before parsing or serializing it in application code. */
export function sanitizeIconSvg(raw: string): string | null {
  try {
    const purifier = DOMPurify(window)
    purifier.addHook("uponSanitizeAttribute", (_node, attribute) => {
      if (["href", "xlink:href"].includes(attribute.attrName) && !/^#[A-Za-z_][\w:.-]*$/.test(attribute.attrValue)) {
        attribute.keepAttr = false
      }
      if (/\\/.test(attribute.attrValue) || (/url\s*\(/i.test(attribute.attrValue) && !/^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/i.test(attribute.attrValue))) {
        attribute.keepAttr = false
      }
    })
    const clean = purifier.sanitize(raw, {
      USE_PROFILES: { svg: true },
      ADD_TAGS: ["use"],
      FORBID_TAGS: ["style", "foreignObject", "image", "a"],
      FORBID_ATTR: ["style"],
      ALLOW_DATA_ATTR: false,
      RETURN_DOM: true,
    })
    if (!(clean instanceof Element)) return null
    const svg = clean.firstElementChild
    if (clean.children.length !== 1 || svg?.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg") return null
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return null
  }
}
