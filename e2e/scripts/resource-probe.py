from pathlib import Path

cpu = Path("/sys/fs/cgroup/cpu.max")
memory = Path("/sys/fs/cgroup/memory.max")

print("cpu.max=" + (cpu.read_text().strip() if cpu.exists() else "missing"))
print("memory.max=" + (memory.read_text().strip() if memory.exists() else "missing"))
