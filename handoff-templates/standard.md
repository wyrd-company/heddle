---
$schema: https://wyrd.company/heddle/handoff-template.schema.json
relationships:
  implements: heddle
format: heddle.handoff-template
version: 1
kind: standard
---
# {{ task.title }}

Work on task {{ task.id }} at stage `{{ handoff.stage.name }}`. Use the stage skill at `{{ handoff.skillPointer }}`.

## Task contract

```json
{{ handoff.taskContract | stableJson }}
```

## Prior stage outputs

```json
{{ handoff.stage.priorStageOutputs | stableJson }}
```

## Todo

{% for list in handoff.todoList.lists %}{% for item in list.items %}- [{% if item.checked %}x{% else %} {% endif %}] {{ item.text }}
{% endfor %}{% endfor %}
