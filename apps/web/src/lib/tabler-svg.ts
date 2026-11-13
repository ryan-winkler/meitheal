/*
 * Selected outline paths from Tabler Icons
 * https://github.com/tabler/tabler-icons/tree/58f60538fe2fab2e1459a09198f9bd3b033bf90e/icons/outline
 *
 * MIT License
 *
 * Copyright (c) 2020-2026 Paweł Kuna
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface SvgNodeDef {
  tag: "path" | "circle" | "rect" | "line" | "polyline";
  attrs: Record<string, string>;
}

const p = (d: string): SvgNodeDef => ({ tag: "path", attrs: { d } });

export const TABLER_ICON_NODES = {
  pin: [p("M16 3l5 5-3 1-3 4v3l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h3l4-3 1-3z")],
  "pinned-off": [
    p("M3 3l18 18"),
    p(
      "M15 4.5l-3.249 3.249m-2.57 1.433l-2.181 .818l-1.5 1.5l7 7l1.5 -1.5l.82 -2.186m1.43 -2.563l3.25 -3.251",
    ),
    p("M9 15l-4.5 4.5"),
    p("M14.5 4l5.5 5.5"),
  ],
  dashboard: [
    { tag: "rect", attrs: { width: "7", height: "9", x: "3", y: "3", rx: "1" } },
    { tag: "rect", attrs: { width: "7", height: "5", x: "14", y: "3", rx: "1" } },
    { tag: "rect", attrs: { width: "7", height: "9", x: "14", y: "12", rx: "1" } },
    { tag: "rect", attrs: { width: "7", height: "5", x: "3", y: "16", rx: "1" } },
  ],
  kanban: [
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "3", rx: "2" } },
    p("M8 7v7"),
    p("M12 7v4"),
    p("M16 7v9"),
  ],
  tasks: [
    { tag: "line", attrs: { x1: "8", x2: "21", y1: "6", y2: "6" } },
    { tag: "line", attrs: { x1: "8", x2: "21", y1: "12", y2: "12" } },
    { tag: "line", attrs: { x1: "8", x2: "21", y1: "18", y2: "18" } },
    { tag: "line", attrs: { x1: "3", x2: "3.01", y1: "6", y2: "6" } },
    { tag: "line", attrs: { x1: "3", x2: "3.01", y1: "12", y2: "12" } },
    { tag: "line", attrs: { x1: "3", x2: "3.01", y1: "18", y2: "18" } },
  ],
  table: [
    p("M12 3v18"),
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "3", rx: "2" } },
    p("M3 9h18"),
    p("M3 15h18"),
  ],
  today: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "polyline", attrs: { points: "12 6 12 12 16 14" } },
  ],
  upcoming: [
    p("M8 2v4"),
    p("M16 2v4"),
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "8", rx: "2" } },
    p("M3 14h18"),
    p("M8 18h8"),
  ],
  calendar: [
    { tag: "rect", attrs: { width: "18", height: "18", x: "3", y: "4", rx: "2", ry: "2" } },
    { tag: "line", attrs: { x1: "16", x2: "16", y1: "2", y2: "6" } },
    { tag: "line", attrs: { x1: "8", x2: "8", y1: "2", y2: "6" } },
    { tag: "line", attrs: { x1: "3", x2: "21", y1: "10", y2: "10" } },
    p("M8 14h.01"),
    p("M12 14h.01"),
    p("M16 14h.01"),
    p("M8 18h.01"),
    p("M12 18h.01"),
    p("M16 18h.01"),
  ],
  "calendar-event": [
    p("M4 5m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"),
    p("M16 3l0 4"),
    p("M8 3l0 4"),
    p("M4 11l16 0"),
    p("M8 15h2v2h-2z"),
  ],
  "calendar-check": [
    p("M11.5 21h-5.5a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v6"),
    p("M16 3v4"),
    p("M8 3v4"),
    p("M4 11h16"),
    p("M15 19l2 2l4 -4"),
  ],
  "chevron-down": [p("M6 9l6 6l6 -6")],
  "chevron-right": [p("M9 6l6 6l-6 6")],
  "chevron-left": [p("M15 6l-6 6l6 6")],
  "arrow-up": [p("M12 5l0 14"), p("M18 11l-6 -6"), p("M6 11l6 -6")],
  "arrow-right": [p("M5 12l14 0"), p("M13 18l6 -6"), p("M13 6l6 6")],
  plus: [p("M5 12h14"), p("M12 5v14")],
  x: [p("M18 6l-12 12"), p("M6 6l12 12")],
  check: [p("M5 12l5 5l10 -10")],
  checkbox: [
    p("M9 11l3 3l8 -8"),
    p("M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9"),
  ],
  "circle-dashed": [
    p("M8.56 3.69a9 9 0 0 0 -2.92 1.95"),
    p("M3.69 8.56a9 9 0 0 0 -.69 3.44"),
    p("M3.69 15.44a9 9 0 0 0 1.95 2.92"),
    p("M8.56 20.31a9 9 0 0 0 3.44 .69"),
    p("M15.44 20.31a9 9 0 0 0 2.92 -1.95"),
    p("M20.31 15.44a9 9 0 0 0 .69 -3.44"),
    p("M20.31 8.56a9 9 0 0 0 -1.95 -2.92"),
    p("M15.44 3.69a9 9 0 0 0 -3.44 -.69"),
  ],
  "circle-check": [
    p("M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"),
    p("M9 12l2 2l4 -4"),
  ],
  settings: [
    p(
      "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065",
    ),
    p("M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"),
  ],
  empty: [
    { tag: "polyline", attrs: { points: "22 12 16 12 14 15 10 15 8 12 2 12" } },
    p("M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"),
  ],
  "menu-open": [
    { tag: "rect", attrs: { x: "4", y: "4", width: "16", height: "16", rx: "2" } },
    p("M9 4v16"),
    p("M15 10l-2 2l2 2"),
  ],
  menu: [p("M4 6l16 0"), p("M4 12l16 0"), p("M4 18l16 0")],
  search: [
    { tag: "circle", attrs: { cx: "11", cy: "11", r: "8" } },
    p("m21 21-4.3-4.3"),
  ],
  filter: [
    p(
      "M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z",
    ),
  ],
  link: [
    p("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"),
    p("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  ],
  sparkles: [
    p("m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3l1.9 5.8 1.9-5.8a2 2 0 0 1 1.3-1.3l5.8-1.9-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"),
  ],
  trophy: [
    p("M6 9H4.5a2.5 2.5 0 0 1 0-5H6"),
    p("M18 9h1.5a2.5 2.5 0 0 0 0-5H18"),
    p("M4 22h16"),
    p("M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22"),
    p("M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22"),
    p("M18 2H6v7a6 6 0 0 0 12 0V2Z"),
  ],
  habit: [
    p("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"),
    p("M21 3v5h-5"),
    p("M12 7v5l3 3"),
  ],
  repeat: [
    p("M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3"),
    p("M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3"),
  ],
  folder: [
    p("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"),
  ],
  folders: [
    p("M9 4h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2"),
    p("M17 17v2a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h2"),
  ],
  target: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "6" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "2" } },
  ],
  eisenhower: [
    { tag: "rect", attrs: { x: "3", y: "3", width: "8", height: "8", rx: "1" } },
    { tag: "rect", attrs: { x: "13", y: "3", width: "8", height: "8", rx: "1" } },
    { tag: "rect", attrs: { x: "3", y: "13", width: "8", height: "8", rx: "1" } },
    { tag: "rect", attrs: { x: "13", y: "13", width: "8", height: "8", rx: "1" } },
    p("M7 7l-2 2"),
    p("M5 7l2 2"),
  ],
  person: [
    p("M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"),
    p("M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"),
  ],
  sliders: [
    p("M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M4 6l8 0"),
    p("M16 6l4 0"),
    p("M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M4 12l2 0"),
    p("M10 12l10 0"),
    p("M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M4 18l11 0"),
    p("M19 18l1 0"),
  ],
  automation: [
    p("M3 17a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -2"),
    p("M15 17a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -2"),
    p("M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -2"),
    p("M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1"),
    p("M12 9l0 3"),
  ],
  plug: [
    p("M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054"),
    p("M4 20l3.5 -3.5"),
    p("M15 4l-3.5 3.5"),
    p("M20 9l-3.5 3.5"),
  ],
  phone: [
    p("M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14"),
    p("M11 4h2"),
    p("M12 17v.01"),
  ],
  warning: [
    p("M12 9v4"),
    p("M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"),
    p("M12 16h.01"),
  ],
  "alert-triangle": [
    p("M12 9v4"),
    p("M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"),
    p("M12 16h.01"),
  ],
  home: [
    p("M5 12l-2 0l9 -9l9 9l-2 0"),
    p("M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"),
    p("M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"),
  ],
  bell: [
    p("M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"),
    p("M9 17v1a3 3 0 0 0 6 0v-1"),
  ],
  cart: [
    p("M4 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M15 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M17 17h-11v-14h-2"),
    p("M6 5l14 1l-1 7h-13"),
  ],
  "shopping-cart": [
    p("M6 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M17 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"),
    p("M17 17h-11v-14h-2"),
    p("M6 5l14 1l-1 7h-13"),
  ],
  info: [
    p("M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"),
    p("M12 9h.01"),
    p("M11 12h1v4h1"),
  ],
  "panel-left-close": [
    p("M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"),
    p("M9 4v16"),
    p("M15 10l-2 2l2 2"),
  ],
  "panel-left-open": [
    p("M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"),
    p("M9 4v16"),
    p("M14 10l2 2l-2 2"),
  ],
  checklist: [
    p("M9.615 20h-2.615a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8"),
    p("M14 19l2 2l4 -4"),
    p("M9 8h4"),
    p("M9 12h2"),
  ],
  inbox: [
    p("M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"),
    p("M4 13h3l3 3h4l3 -3h3"),
  ],
  sun: [
    p("M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"),
    p("M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"),
  ],
  flame: [
    p("M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.294 -2.333 5.588c0 3.704 3.134 6.706 7 6.706c3.866 0 7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235"),
  ],
  palette: [
    p(
      "M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25",
    ),
    p("M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
    p("M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
    p("M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
  ],
  key: [
    p(
      "M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0",
    ),
    p("M15 9h.01"),
  ],
  lock: [
    p("M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"),
    p("M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"),
    p("M8 11v-4a4 4 0 1 1 8 0v4"),
  ],
  copy: [
    p("M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"),
    p("M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"),
  ],
  ban: [
    p("M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"),
    p("M5.7 5.7l12.6 12.6"),
  ],
  trash: [
    p("M4 7l16 0"),
    p("M10 11l0 6"),
    p("M14 11l0 6"),
    p("M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"),
    p("M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"),
  ],
  pencil: [
    p("M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"),
    p("M13.5 6.5l4 4"),
  ],
  dots: [
    p("M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
    p("M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
    p("M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
  ],
  "clock-pause": [
    p("M20.942 13.018a9 9 0 1 0 -7.909 7.922"),
    p("M12 7v5l2 2"),
    p("M17 17v5"),
    p("M21 17v5"),
  ],
  hourglass: [
    p("M6.5 7h11"),
    p("M6.5 17h11"),
    p("M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z"),
    p("M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"),
  ],
  pillars: [
    p("M3 21h18"),
    p("M3 10h18"),
    p("M5 6l7 -3l7 3"),
    p("M4 10v11"),
    p("M20 10v11"),
    p("M8 14v3"),
    p("M12 14v3"),
    p("M16 14v3"),
  ],
  bulb: [
    p("M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7"),
    p("M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3"),
    p("M9.7 17l4.6 0"),
  ],
  robot: [
    p("M6 4m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"),
    p("M12 2v2"),
    p("M9 12v9"),
    p("M15 12v9"),
    p("M5 16l4 -2"),
    p("M15 14l4 2"),
    p("M9 18h6"),
    p("M10 8v.01"),
    p("M14 8v.01"),
  ],
  rocket: [
    p("M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3"),
    p("M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3"),
    p("M15 9m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"),
  ],
  dice: [
    p("M3 3m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"),
    p("M8.5 8.5m-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0"),
    p("M15.5 8.5m-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0"),
    p("M15.5 15.5m-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0"),
    p("M8.5 15.5m-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0"),
  ],
  award: [
    p("M12 9m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0"),
    p("M12 15l3.4 5.89l1.598 -3.233l3.598 .232l-3.4 -5.889"),
    p("M6.802 12l-3.4 5.89l3.598 -.233l1.598 3.232l3.4 -5.889"),
  ],
  medal: [
    p("M12 4v3m-4 -3v6m8 -6v6"),
    p("M12 18.5l-3 1.5l.5 -3.5l-2 -2l3 -.5l1.5 -3l1.5 3l3 .5l-2 2l.5 3.5z"),
  ],
  scale: [
    p("M7 20l10 0"),
    p("M6 6l6 -1l6 1"),
    p("M12 3l0 17"),
    p("M9 12l-3 -6l-3 6a3 3 0 0 0 6 0"),
    p("M21 12l-3 -6l-3 6a3 3 0 0 0 6 0"),
  ],
  "trending-up": [p("M3 17l6 -6l4 4l8 -8"), p("M14 7l7 0l0 7")],
  message: [p("M8 9h8"), p("M8 13h6"), p("M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z")],
  activity: [p("M3 12h4l3 8l4 -16l3 8h4")],
  bolt: [p("M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11")],
  hash: [p("M5 9l14 0"), p("M5 15l14 0"), p("M11 4l-4 16"), p("M17 4l-4 16")],
  paperclip: [p("M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5")],
  "align-left": [p("M4 6l16 0"), p("M4 12l10 0"), p("M4 18l14 0")],
} as const satisfies Record<string, readonly SvgNodeDef[]>;

export type TablerIconName = keyof typeof TABLER_ICON_NODES;

const SVG_NS = "http://www.w3.org/2000/svg";

export function createTablerSvgElement(
  name: TablerIconName,
  size = 16,
  className?: string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);

  const nodes = TABLER_ICON_NODES[name] ?? TABLER_ICON_NODES.checkbox;
  for (const node of nodes) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [attr, value] of Object.entries(node.attrs)) {
      child.setAttribute(attr, value);
    }
    svg.appendChild(child);
  }
  return svg;
}

const DEFAULT_EMOJI_TO_TABLER: Record<string, TablerIconName> = {
  "🏠": "home",
  "🏡": "home",
  "🗂": "folders",
  "🗂️": "folders",
  "📁": "folder",
  "📂": "folder",
  "☀️": "sun",
  "☀": "sun",
  "📋": "checklist",
  "📥": "inbox",
  "⚡": "bolt",
  "✅": "checkbox",
  "☑️": "checkbox",
  "🛒": "shopping-cart",
  "📅": "calendar-event",
  "🗓️": "calendar",
  "🗓": "calendar",
  "🏛️": "pillars",
  "🏛": "pillars",
  "🔁": "repeat",
  "🔄": "repeat",
  "🎯": "target",
  "🏆": "trophy",
  "💡": "bulb",
  "⚖️": "scale",
  "⚖": "scale",
  "📈": "trending-up",
  "📊": "trending-up",
  "🔥": "flame",
  "✨": "sparkles",
  "🚀": "rocket",
  "🎲": "dice",
  "🎨": "palette",
  "🔑": "key",
  "🔒": "lock",
  "⚙️": "settings",
  "⚙": "settings",
  "📌": "pin",
  "🏅": "medal",
  "🛡️": "award",
  "🔌": "plug",
  "🔔": "bell",
  "🏷️": "filter",
  "🏷": "filter",
};

export function mapEntityEmojiToTabler(raw?: string | null): TablerIconName | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed in TABLER_ICON_NODES) return trimmed as TablerIconName;
  return DEFAULT_EMOJI_TO_TABLER[trimmed] ?? null;
}

export function resolveAchievementTablerIcon(idOrIcon?: string | null): TablerIconName {
  const key = (idOrIcon ?? "").trim().toLowerCase();
  if (!key) return "award";
  const mapped = mapEntityEmojiToTabler(idOrIcon);
  if (mapped) return mapped;
  if (key.includes("first")) return "target";
  if (key.includes("100") || key.includes("century") || key.includes("champion")) return "trophy";
  if (key.includes("50")) return "bolt";
  if (key.includes("25") || key.includes("quarter")) return "dice";
  if (key.includes("10")) return "rocket";
  if (key.includes("streak")) return "flame";
  if (key.includes("xp") || key.includes("sparkle")) return "sparkles";
  if (key.includes("level")) return "medal";
  return "award";
}

export function renderIconOrCustomEmoji(
  container: HTMLElement,
  rawIcon: string | null | undefined,
  fallbackIcon: TablerIconName,
  size = 16,
  className?: string,
): void {
  const trimmed = rawIcon?.trim();
  const mapped = trimmed ? mapEntityEmojiToTabler(trimmed) : fallbackIcon;
  if (mapped) {
    container.replaceChildren(createTablerSvgElement(mapped, size, className));
    return;
  }
  container.textContent = trimmed || "";
}
