/** Type declaration for frappe-gantt (no @types package available) */
declare module "frappe-gantt" {
  interface GanttTask {
    id: string
    name: string
    start: string | Date
    end?: string | Date
    duration?: string
    progress?: number
    dependencies?: string | string[]
    color?: string
    color_progress?: string
    custom_class?: string
    description?: string
    important?: boolean
    [key: string]: unknown
  }

  interface GanttViewMode {
    name: string
    padding?: string
    step?: string
    column_width?: number
    date_format?: string
    snap_at?: string
    lower_text?: (currentDate: Date, previousDate: Date | null, lang: string) => string
    upper_text?: (currentDate: Date, previousDate: Date | null, lang: string) => string
    upper_text_frequency?: number
    thick_line?: (date: Date) => boolean
  }

  interface GanttOptions {
    view_mode?: string | GanttViewMode
    view_mode_select?: boolean
    view_modes?: (string | GanttViewMode)[]
    bar_height?: number
    bar_corner_radius?: number
    padding?: number
    column_width?: number
    upper_header_height?: number
    lower_header_height?: number
    container_height?: string | number
    snap_at?: string
    infinite_padding?: boolean
    auto_move_label?: boolean
    move_dependencies?: boolean
    readonly?: boolean
    readonly_dates?: boolean
    readonly_progress?: boolean
    date_format?: string
    language?: string
    scroll_to?: string | Date
    holidays?: Record<string, string | Array<{ date: string; label: string }>>
    ignore?: string[]
    is_weekend?: (d: Date) => boolean
    lines?: string
    arrow_curve?: number
    show_expected_progress?: boolean
    today_button?: boolean
    popup_on?: string
    popup?: (ctx: {
      set_title: (t: string) => void
      set_subtitle: (s: string) => void
      set_details: (d: string) => void
      task: GanttTask & { _start: Date; _end: Date; _index: number }
      chart: { options: GanttOptions }
    }) => void
    on_date_change?: (task: GanttTask & { _start: Date; _end: Date }, start: Date, end: Date) => void
    on_progress_change?: (task: GanttTask, progress: number) => void
    on_click?: (task: GanttTask) => void
    on_double_click?: (task: GanttTask) => void
    on_hover?: (task: GanttTask, screenX: number, screenY: number, event: Event) => void
    on_view_change?: (viewMode: { name: string }) => void
  }

  class Gantt {
    constructor(wrapper: string | HTMLElement, tasks: GanttTask[], options?: GanttOptions)
    change_view_mode(mode: string | GanttViewMode, maintain_scroll?: boolean): void
    refresh(tasks: GanttTask[]): void
  }

  export default Gantt
  export type { GanttTask, GanttOptions, GanttViewMode }
}
