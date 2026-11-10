#!/usr/bin/env bash
# Pass as bash -c with the fixed workload on stdin. Keep the parent alive for
# final cgroup evidence before the container runtime applies --rm.
set -u

read_uptime() {
  local uptime unused
  read -r uptime unused < /proc/uptime || return 1
  [[ "$uptime" =~ ^([0-9]{1,12})\.([0-9]{2})$ ]] || return 1
  uptime_cs=$((10#${BASH_REMATCH[1]} * 100 + 10#${BASH_REMATCH[2]}))
}

read_cpu() {
  local key value extra user_count=0 system_count=0
  cpu_user=missing cpu_system=missing
  while read -r key value extra; do
    case "$key" in
      user_usec) cpu_user=$value; user_count=$((user_count + 1)) ;;
      system_usec) cpu_system=$value; system_count=$((system_count + 1)) ;;
    esac
  done < /sys/fs/cgroup/cpu.stat || return 1
  [[ "$user_count" == 1 && "$system_count" == 1 &&
    "$cpu_user" =~ ^[0-9]{1,18}$ && "$cpu_system" =~ ^[0-9]{1,18}$ ]]
}

clock_status=0
start_cs=missing start_user=missing start_system=missing
end_cs=missing end_user=missing end_system=missing
if read_uptime; then start_cs=$uptime_cs; else clock_status=125; fi
if read_cpu; then start_user=$cpu_user; start_system=$cpu_system; else clock_status=125; fi

bash -s -- "$@"
workload_status=$?

if read_uptime; then end_cs=$uptime_cs; else clock_status=125; fi
if read_cpu; then end_user=$cpu_user; end_system=$cpu_system; else clock_status=125; fi
printf 'driver_clock,v1,uptime_start_cs=%s,uptime_end_cs=%s,user_start_usec=%s,system_start_usec=%s,user_end_usec=%s,system_end_usec=%s\n' \
  "$start_cs" "$end_cs" "$start_user" "$start_system" "$end_user" "$end_system" >&2
if [[ "$clock_status" == 0 ]]; then
  if ((end_cs < start_cs || 10#$end_user < 10#$start_user || 10#$end_system < 10#$start_system)); then
    clock_status=125
  else
    wall_cs=$((end_cs - start_cs))
    user_usec=$((10#$end_user - 10#$start_user))
    system_usec=$((10#$end_system - 10#$start_system))
    printf 'driver_seconds,%d.%03d,%d.%03d,%d.%03d\n' \
      "$((wall_cs / 100))" "$((wall_cs % 100 * 10))" \
      "$((user_usec / 1000000))" "$((user_usec % 1000000 / 1000))" \
      "$((system_usec / 1000000))" "$((system_usec % 1000000 / 1000))" >&2
  fi
fi

# Builtins only: telemetry must not add another process to this capped cgroup.
receipt_status=$clock_status
memory_max=missing swap_max=missing swap_current=missing
cpu_quota=missing cpu_period=missing
event_max=missing event_oom=missing event_oom_kill=missing
event_oom_group_kill=absent
read -r memory_max < /sys/fs/cgroup/memory.max || receipt_status=125
read -r swap_max < /sys/fs/cgroup/memory.swap.max || receipt_status=125
read -r swap_current < /sys/fs/cgroup/memory.swap.current || receipt_status=125
read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max || receipt_status=125
while read -r key value; do
  case "$key" in
    max) event_max=$value ;;
    oom) event_oom=$value ;;
    oom_kill) event_oom_kill=$value ;;
    oom_group_kill) event_oom_group_kill=$value ;;
  esac
done < /sys/fs/cgroup/memory.events || receipt_status=125
for value in "$event_max" "$event_oom" "$event_oom_kill" "$swap_current"; do
  [[ "$value" == 0 ]] || receipt_status=125
done
[[ "$event_oom_group_kill" == absent || "$event_oom_group_kill" == 0 ]] || receipt_status=125
[[ "$memory_max" == 83886080 && "$swap_max" == 0 && "$cpu_quota" == 100000 && "$cpu_period" == 100000 ]] || receipt_status=125
printf 'driver_cgroup_receipt,v1,workload_status=%s,receipt_status=%s,memory.max=%s,memory.swap.max=%s,memory.swap.current=%s,cpu.max=%s %s,max=%s,oom=%s,oom_kill=%s,oom_group_kill=%s\n' \
  "$workload_status" "$receipt_status" "$memory_max" "$swap_max" "$swap_current" "$cpu_quota" "$cpu_period" \
  "$event_max" "$event_oom" "$event_oom_kill" "$event_oom_group_kill" >&2
if [[ "$workload_status" != 0 ]]; then exit "$workload_status"; fi
exit "$receipt_status"
