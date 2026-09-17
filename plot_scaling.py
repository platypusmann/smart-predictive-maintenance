import csv
import matplotlib.pyplot as plt
from datetime import datetime

times = []
messages = []
running = []
desired = []

with open('infra/aws/scripts/scaling-run1.csv') as f:
    reader = csv.DictReader(f)
    for row in reader:
        times.append(datetime.strptime(row['time'], '%H:%M:%S'))
        messages.append(int(row['messages_waiting']))
        running.append(int(row['running_tasks']))
        desired.append(int(row['desired_tasks']))

fig, ax1 = plt.subplots(figsize=(11, 6))

ax1.set_xlabel('Time')
ax1.set_ylabel('Messages waiting in queue', color='tab:blue')
ax1.plot(times, messages, color='tab:blue', linewidth=2, label='Queue depth')
ax1.tick_params(axis='y', labelcolor='tab:blue')

ax2 = ax1.twinx()
ax2.set_ylabel('Inference tasks', color='tab:red')
ax2.plot(times, running, color='tab:red', linewidth=2, marker='o', markersize=3, label='Running tasks')
ax2.plot(times, desired, color='tab:red', linestyle='--', linewidth=1, alpha=0.6, label='Desired tasks')
ax2.tick_params(axis='y', labelcolor='tab:red')
ax2.set_ylim(0, 11)

fig.autofmt_xdate()
plt.title('Queue depth versus inference task count during the load test')

lines1, labels1 = ax1.get_legend_handles_labels()
lines2, labels2 = ax2.get_legend_handles_labels()
ax1.legend(lines1 + lines2, labels1 + labels2, loc='upper left')

plt.tight_layout()
plt.savefig('scaling-graph.png', dpi=150)
print('saved scaling-graph.png')
