# pepa v0.3.0 — Maslow + Awareness

Concept: needs-based hierarchical agent with real-time event awareness and a
fast LLM tactical advisor. Pi (CLI) stays for slow deep analytics
(postmortem, reflection). A second, fast LLM tier (TimeWeb / OpenAI-
compatible) handles "what to do right now" decisions when the reflex
detects wedged/stuck/changed environment.

This is a major behavioural rewrite over v0.2.x:

- v0.2.x had a flat reflex chain (modes → defend → eat → sleep →
  curriculum → idle) — curriculum was just "next mode". The bot had no
  internal concept of "do I have a pickaxe?" let alone "do I have a
  shelter?" Lessons from Pi were hallucinated skill names (47/47
  Pi-extracted lessons applied_count=0 as of v0.2.0-rc.3).
- v0.3.0 introduces a **needs ladder** (Maslow-like) that drives the
  bot's intent end-to-end, an **awareness layer** that reacts to env
  changes within ~100ms instead of waiting for the next tick boundary,
  and a **fast LLM** tier that closes the loop when the bot is stuck.

## Concept terms

This pattern is called variously in the AI literature:
- **Hierarchical Task Network (HTN)** planning — Voyager uses this
- **Needs-based / utility AI** — game-AI mainstream
- **BDI agent** (Beliefs-Desires-Intentions) — academic AI
- **Subsumption architecture** (Brooks) — reactive layers preempt
  deliberative layers when conditions trigger

Pepa v0.3.0 is essentially **Maslow-stack curriculum + Brooks-style
preemption + dual-tier LLM (fast tactical + slow analytical)**.

## Manifesto / Needs ladder

```
L0  alive          HP>5, не тонет, не горит, не падает с фатальной высоты
L1  food           ≥6 насыщения (готов кушать на месте)
L2  tools_wood     wooden_pickaxe + wooden_axe + wooden_sword
L3  shelter_basic  4 стены + крыша + кровать в радиусе 8 от спавн-base
L4  tools_stone    stone_pickaxe + stone_axe + stone_sword
L5  armor_basic    хотя бы один кусок (predпочтительно нагрудник)
L6  food_security  ≥16 еды + источник (ферма / стая коров рядом)
L7  tools_iron     iron_pickaxe + iron_axe + iron_sword
L8  armor_iron     полный iron set
L9  village_seed   2+ постройки, забор/оградка, базовая ферма
L10 village_full   глобальная цель (ферма + дом + сосед-NPC мечта)
```

На каждом тике reflex выбирает **самую нижнюю неудовлетворённую** нужду.
Эта нужда становится **активной**. Curriculum.next() и Pi-coach подсказки
дальше выбираются **внутри** активной нужды. Если нужда сменилась
(например, HP упало → L0 проснулся), текущий skill прерывается.

## v0.3.0 release plan (3 rc)

### rc.1 — Skill registry hardening + Fast advisor scaffold
**Цель**: убрать главную проблему v0.2.x — Pi инвентит skill names.
Не вводим манифест ещё, но строим инфраструктуру для него.

- `runtime/skill-registry.js` — exported `listSkillIds()`, `isRegistered(id)`,
  `skillRegistryPrompt()` (готовый блок текста для LLM-промпта со списком
  валидных id, по группам)
- Все Pi-промпты (`coach/postmortem.js`, `coach/reflect.js`) передают
  реестр в system prompt
- `runtime/coach/advice.js`: `normalisePreferSkill` строго отбрасывает
  всё, что не в реестре (raise log, не дрейфит на fuzzy)
- `runtime/llm/provider.js` — OpenAI-совместимый клиент, конфигурируется
  через env (`TIMEWEB_BASE_URL`, `TIMEWEB_API_KEY`, `TIMEWEB_MODEL`); graceful
  fallback "no-op" если env не задан (бот не падает)
- `runtime/coach/fast-advisor.js` — функция `advise({snapshot, reason})`
  с rate-limit (макс. 6 вызовов/час), таймаут 8с, JSON-парсинг ответа
  через тот же `extractJson()` что у Pi. **Пока не подключаем к reflex** —
  scaffold + тесты
- Тесты для каждого нового модуля + регрессионный тест:
  `advice.test.js` проверяет что hallucinated `relocate.surface` falls
  through (никакой override)
- Минимум 270+ зелёных тестов

### rc.2 — Manifesto / Needs ladder + curriculum integration
**Цель**: bot acts toward concrete needs, not toward "explore further".

- `runtime/manifesto/needs.js` — каталог 11 нужд, каждая со схемой:
  ```
  { id, level, detect(snapshot) → boolean satisfied, prefer_skill_for_pursuit, ... }
  ```
- `runtime/manifesto/state.js` — `pickActiveNeed(snapshot)` возвращает
  самую нижнюю неудовлетворённую. Кеширует на 5с.
- `runtime/reflex.js`:
  - В `curriculumReflex` сначала `activeNeed = pickActiveNeed(...)`
  - Skill подбирается в первую очередь по `activeNeed.prefer_skill_for_pursuit`
  - Fallback на curriculum.next() только если нужда не дала однозначного skill
- `runtime/coach/advice.js`: `consult()` теперь принимает `activeNeed` и
  отбрасывает lessons чьи trigger_situation противоречит текущей нужде
  (например, "избегай ночью гулять" не применяется когда L0=alive в опасности)
- Pi-промпты (postmortem, reflect) получают `currentNeed: "L2 tools_wood"`
  и просят Pi дать совет именно для этого уровня
- Новый персонаж reflex hook: при смене activeNeed бот произносит в чате
  "пора заняться X" (Russian narration tying into chatter.js)
- Тесты: каждая нужда имеет 2-3 теста (detect satisfied/unsatisfied,
  правильный prefer_skill)

### rc.3 — Event-driven awareness + skill pre-emption
**Цель**: bot reacts within ~100ms to env changes (fall, teleport,
damage, hostile spawn near).

- `runtime/awareness/events.js` — установка listeners:
  - `bot.on('move')` — детект position-jump >5 блоков за тик → событие
    `forced-move` → инвалидация current dispatch context
  - `bot.on('health')` — снижение HP > 2 за тик → reflex.preempt()
  - `bot.on('entitySpawn')` — враждебный <12 блоков → reflex.preempt()
  - `bot.on('blockUpdate')` около бота (manhattan <4) → пометка
    `environment_changed=true`
- `runtime/awareness/state.js` — храним flags `(forcedMove, lastDamage,
  hostileAdded, envChanged)`, expose `consumeFlags()` для reflex
- Skill protocol extended: `execute(ctx, args)` теперь получает
  `ctx.abortSignal` (AbortSignal). Длинные операции (pathfinder.goto,
  collectBlock loops) проверяют `signal.aborted` между шагами и сразу
  возвращают `{ok: false, code: 'preempted'}`
- `runtime/reflex.js`: при срабатывании preempt-флагов вызывается
  `currentDispatch?.abort()`, и reflex запускает следующий тик
  немедленно (не ждёт `DISPATCH_INTERVAL_MS`)
- `recovery.tunnel-out`, `survive.pillar-up`, `gather.logs`, `explore.far`
  адаптируются под AbortSignal (минимальное — `if (signal.aborted)
  return { ok:false, code:'preempted' }` после каждого `await`)
- **Связка с fast advisor**: когда preempt сработал из-за `forcedMove`
  или environment_changed, и reflex не находит очевидный skill, вызывает
  `fastAdvisor.advise(...)` чтобы получить тактический совет (rc.1
  scaffolding активируется здесь)

### Acceptance signals (после rc.3)

- В живой БД: `lessons WHERE applied_count > 0` растёт (сейчас 3,
  должно стать 20+ за сутки)
- Bot движется к конкретным целям: видимый прогресс инвентаря (wood →
  pickaxe → stone → axe), а не "блуждание в одном квадранте"
- При forcedMove бот меняет план в течение секунды, не продолжает
  старый skill
- Fast advisor пакетно срабатывает <10 раз/час, каждый раз приводит к
  смене skill (логируется)

## Что отложено в v0.3.1

- **Vision** (multimodal LLM на скриншотах) — требует prismarine-viewer
  pipeline + multimodal model в провайдере; не в первом релизе
- **Vector memory of scenarios** — embeddings от похожих ситуаций
- **Auto-curriculum from wiki** — фоновый паук minecraft.wiki

## Workflow notes

- Каждый rc — отдельный PR, мержим после approve
- main защищён, auto-patch открывает PR с тегом `auto-patch`
- Если что-то ломается в проде (живой бот в петле >30 мин), откатываем
  на v0.2.0-rc.3 commit `865aae1` через `git checkout <commit>` на
  ветке `revert/v0.3.0-stability`
- Тестовые данные строго в `/tmp/pepa-test-state-*` (исправлено в v0.2.0-rc.2)
