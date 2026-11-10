/**
 * Labels Domain — Public API
 *
 * @kcs This barrel file is the only public import path for the labels domain.
 * Cross-context imports should use: import { ... } from "@domains/labels"
 */

export {
  listLabels,
  createLabel,
  normalizeLabelTitle,
  taskLabelInsert,
  updateLabel,
  deleteLabel,
  getLabelColorMap,
  type Label,
} from "./label-store"

export {
  resolveLabelColor,
  resolveLabelVariant,
  resolveAllLabelColors,
  resetColorCache,
} from "./label-color-resolver"

export {
  UnusedLabelRepository,
  type CleanupLabel,
  type CleanupPreview,
  type CleanupRemoval,
  type CleanupSelection,
} from "./unused-labels"
