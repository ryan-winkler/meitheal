import re

with open("apps/web/src/components/tasks/TaskDetailModal.astro", "r") as f:
    content = f.read()

# 1. Title resizing
title_old = """            <!-- Title -->
            <div class="relative group">
              <textarea
                id="td-title"
                class="w-full bg-transparent border border-transparent hover:bg-bg-hover focus:bg-bg-input focus:border-border focus:ring-1 focus:ring-accent text-3xl font-bold py-2 px-3 -ml-3 rounded-lg transition-colors leading-tight resize-none text-text-primary overflow-hidden"
                rows="1"
                placeholder="Task title"
              ></textarea>
            </div>"""

title_new = """            <!-- Title -->
            <div class="relative group">
              <textarea
                id="td-title"
                class="w-full bg-transparent border border-transparent hover:bg-bg-hover focus:bg-bg-input focus:border-border focus:ring-1 focus:ring-accent text-3xl font-bold py-2 px-3 -ml-3 rounded-lg transition-colors leading-tight resize-none text-text-primary overflow-hidden min-h-[56px]"
                rows="1"
                placeholder="Task title"
                oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"
              ></textarea>
            </div>"""

content = content.replace(title_old, title_new)

# 2. Extract Comments and Activity Log
comments_start = content.find("            <!-- Comments -->")
activity_end = content.find("            </details>", comments_start) + len("            </details>")

comments_and_activity = content[comments_start:activity_end]

# Remove them from <main>
content = content[:comments_start] + content[activity_end:]

# 3. Extract Properties
props_start = content.find("            <!-- Essential Properties -->")
props_end = content.find("            <!-- Strategic Actions -->")

properties_html = content[props_start:props_end]

# Modify properties_html to be more horizontal
properties_html = properties_html.replace('space-y-3 text-sm', 'grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 text-sm w-full')
properties_html = properties_html.replace('space-y-4', 'grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm w-full')
properties_html = properties_html.replace('space-y-5', 'grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm w-full')
properties_html = properties_html.replace('<hr class="border-border">', '')

# Remove from sidebar
content = content[:props_start] + content[props_end:]

# 4. Insert Properties into <main> under Title
insert_props_at = content.find("            <!-- Description -->")
props_wrapper = f"""            <!-- Properties Grid -->
            <div class="flex flex-col gap-5 py-5 mb-8 border-y border-border/50 bg-bg-card/10 -mx-6 px-6 lg:-mx-10 lg:px-10">
{properties_html}
            </div>

"""
content = content[:insert_props_at] + props_wrapper + content[insert_props_at:]

# 5. Insert Comments/Activity into <aside>
insert_activity_at = content.find("            <!-- Strategic Actions -->")
activity_wrapper = f"""{comments_and_activity}

"""
content = content[:insert_activity_at] + activity_wrapper + content[insert_activity_at:]


# 6. Fix Related Links Overflow (allow dropdown to overflow main)
content = content.replace("overflow-visible md:overflow-y-auto px-6 py-6 lg:px-10 space-y-8 bg-transparent min-w-0", "overflow-visible px-6 py-6 lg:px-10 space-y-8 bg-transparent min-w-0")
content = content.replace('id="td-loaded-content" class="flex flex-1 overflow-y-auto md:overflow-hidden flex-col md:flex-row relative hidden"', 'id="td-loaded-content" class="flex flex-1 overflow-y-auto flex-col md:flex-row relative hidden"')
content = content.replace("overflow-visible md:overflow-y-auto flex flex-col gap-6", "flex flex-col gap-6")


with open("apps/web/src/components/tasks/TaskDetailModal.astro", "w") as f:
    f.write(content)

