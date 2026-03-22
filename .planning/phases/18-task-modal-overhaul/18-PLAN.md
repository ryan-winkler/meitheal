# Phase 18: Task Modal Overhaul - Implementation Plan

## Overview
This plan details the exact files and changes required to overhaul the `NewTaskModal` and `TaskDetailModal` across Meitheal, transforming them from standard native wrappers into premium, glassmorphism-infused, dual-column overlay interfaces focused on rapid execution and strategic context.

## 1. UI Foundation & Theming (`apps/web/src/index.css`)
- **Action:** Ensure existing CSS variables maps accurately to a true "Neon Nocturne" glassmorphism aesthetic.
- **Details:** Add any missing classes for `.swimlane-pill-active` and `.swimlane-pill-inactive` if they can't be purely constructed with existing Tailwind utilities.

## 2. New Task Modal (`apps/web/src/components/tasks/NewTaskModal.astro`)
- **Aesthetic:** Apply `backdrop-blur` to the dialog backdrop. Make the modal container distinct but slightly transparent (`bg-bg-primary/95`).
- **Title Field:** Convert `<input name="title">` to `<textarea name="title" rows="1" class="resize-none overflow-hidden ...">`.
- **Status Swimlines:** 
  - Hide the original `<select name="status">` element using `<input type="hidden">`.
  - Create a flex container with 4 buttons (Backlog, Todo, In Progress, Done).
  - Add `data-status-pill="..."` attributes for the controller to bind.

## 3. Edit Task Modal (`apps/web/src/components/tasks/TaskDetailModal.astro`)
- **Layout Restructure:**
  - Increase the max width from `max-w-xl` to `max-w-4xl` or `max-w-5xl`.
  - Introduce a CSS Grid or Flex split (`md:grid md:grid-cols-3` or `md:grid-cols-12` where main is 8 cols, sidebar is 4 cols).
- **Left Column (Main):**
  - Expanding Title Textarea.
  - Markdown Description editor.
  - Subtasks/Checklists block.
- **Right Column (Metadata & Strategy):**
  - Status Swimlanes (same pill paradigm as New Task).
  - Date selectors.
  - Assigned Pillar selection.
  - Priority selection. 
  - Embed the `StrategicEvaluator` component here instead of keeping it completely disjointed. Let the modal itself contain strategic alignment visually.

## 4. DOM Controller (`apps/web/src/lib/task-modal-controller.ts`)
- **Auto-Resize Titles:** Add an event listener for `input` on elements matching `textarea[name="title"]` to dynamically adjust `style.height` based on `scrollHeight`.
- **Status Delegation:** Add a click delegator for `[data-status-pill]`. When clicked:
  - Remove active classes from sibling pills.
  - Add active class to clicked pill.
  - Find the sibling `<input type="hidden" name="status">` within the form and update its `.value`.
- **Initialization:** Ensure that opening the `TaskDetailModal` reads the loaded status and correctly highlights the right swimlane pill on boot.

## 5. Timeline / Kanban Compatibility
- **Action:** Ensure that nothing in the form submission pipeline changes drastically. Since we are falling back to a hidden `<input name="status">`, normal `FormData` parsing in the existing Astro APIs will continue to work perfectly without requiring backend rewrites.
