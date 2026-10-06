# Timesheet Filling Spec - To Be used with AI (Claude)

# Timesheet Filling Spec: Karan Kaushik

Derived from three months of actual timesheets (Jun, Jul, Aug 2026): 92 calendar rows, 65 working days, 66 work items.

## 1. Workbook structure

* **One file per month**, named `YY-MM_Timesheet-Karan.xlsx` (the Aug file uses `_Karan`; pick one separator and stick to it).
* **Two sheets**: `Codes - 01 May 26` (project list, never edited) and a month sheet named `Mon YYYY`.
* **Every calendar day gets a row**, Saturdays and Sundays included, even when empty. Weekend rows stay blank, total 0.
* **Columns**: DOW, Date, four `Hours Worked` slots, Total (`=SUM(E:H)`), then up to four Project + Description pairs.
* **Footer** `TOTAL HOURS WORKED` sums each hours column.
* **Project** comes from the dropdown in the Codes sheet, copied exactly (including odd spacing like `JLP/ Waitrose Customer projects`).

## 2. Hours

* **8 hours per working day**, whole numbers, Mon–Fri only. Every working day in June and August is exactly 8.
* Monthly totals: Jun 176 (22 days), Aug 160 (20 days entered).
* **Splits are rare**: one day in three months (4h + 4h). Both halves went to the *same* project with two different descriptions, so a split is used to log two distinct activities, not two projects.
* No weekend work logged, no part-day entries.

## 3. Projects per day

| Metric                            | Value                                                     |
| --------------------------------- | --------------------------------------------------------- |
| Average projects per day          | **1.0** (64 of 65 working days had exactly one project)   |
| Average description lines per day | 1.02                                                      |
| Distinct projects per month       | 2–3                                                       |
| Average run on the same project   | ~4.3 working days                                         |
| Longest run                       | 16 consecutive days (FPS - Internal Platform development) |

**Project mix across 66 items:**

* FPS - Internal Platform development: 39 (59%)
* JLP/ Waitrose Customer projects: 21 (32%)
* GR - SLICED 2: 4 (June only)
* Wincanton: 2

You switch project on about 1 in 5 days, usually in blocks (e.g. SLICED 2 for four days, then FPS for a stretch, then JLP for a stretch).

## 4. Description style

**Length**

* **Average 4.8 words, median 5, most common 5.** Range 1–13.
* About three-quarters of descriptions are 3–8 words. Average ~36 characters.
* Trend: June averaged **3.5 words**, July **5.7**, August **5.3**. Descriptions got longer and more specific after June.

**Form**

* One line per project per day. No bullets, no full sentences, **no trailing full stops** (0 of 66).
* Two patterns, in rough order of use:
  1. **Component + activity noun**: `Nexus updates`, `FCMS review`, `Grafana vis testing`
  2. **Past-tense verb + object**: `Implemented Optimizer v2 trigger flow, cloning scripts, cron updates`
* June was ~90% pattern 1 (and often lowercase); Jul–Aug is ~57% pattern 2.
* Opening words you reach for: *Nexus, Optimiser, Testing, FCMS, Investigated, Progressed, Updated, Continued, Planned*.
* Product names appear as proper nouns: Nexus, FCMS, Grafana, Webfleet, TomTom, Ford Pro, Coulsdon.
* Jargon and abbreviations are used freely: `OL`, `VOR`, `PM`, `env var`, `RFID`, `v2/v3`, `dev/prod`. Assumes the reader knows the systems.
* Preferred spelling is British (`Optimiser`), with occasional `Optimizer`. Pick one.

**Vocabulary that carries most of the meaning:** testing, updates, review, validation, deployment, architecture, integration, fix, cloning, allocation.

## 5. Examples

**Good entries (your best, typical of Jul–Aug):**

| Words      | Entry                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------- |
| 3          | `Nexus updates`                                                                              |
| 4          | `FCMS plan-date filtering fix`                                                               |
| 5          | `Released FCMS options generator v2.0.2`                                                     |
| 5          | `Resolved Ford Pro feed outage`                                                              |
| 6          | `Added FCMS allocation generator tests`                                                      |
| 7          | `Investigated FCMS PM route-allocation bug`                                                  |
| 8          | `Reviewed FCMS integration bugs - VOR and batching`                                          |
| 9          | `Designed Overload Limiter architecture, concurrency model and deployment testing procedure` |

**Weaker entries (vague or too short):**

* `Testing` (1 word, no subject)
* `Steve testing`
* `Testing and eval`

**The 4+4 split day (10 Aug):**

* 4h: `JLP external overload limiter discussion`
* 4h: `Architecture updates overload limiter`

## 6. Rules to follow going forward

1. One project per day unless the day genuinely splits; if split, 4h + 4h.
2. 8h per working day, whole numbers, in the first hours column.
3. Description of 4–8 words: **[Past-tense verb] + [system] + [specific thing]**.
4. Name the system or component (Nexus, FCMS, Optimiser, Overload Limiter) in every entry. Avoid bare "Testing".
5. Capitalise the first word. No full stop.
6. Fill hours *and* descriptions. Do not leave hours blank.
7. Code bank holidays as `BKH - Bank holiday` and leave days as `ALZ - Annual Leave`; do not leave the row empty.
8. Spell-check before saving (see below).

## 7. Other insights and issues spotted

* **July hours are all blank.** Descriptions are filled for all 23 working days but every Hours cell is empty, so the sheet totals **0**. It needs 8h on each working day (184h).
* **31 Aug is empty.** It's the UK summer bank holiday, but isn't coded `BKH - Bank holiday`, so it looks like an unfilled day.
* **Inconsistent project coding for similar work.** FCMS and Overload Limiter work is usually under `JLP/ Waitrose Customer projects`, but `Built optimizer-v3 overload limiter tests` (11 Aug) and `Prepared deployment validation testing procedure for allocation` (12 Aug) went to `FPS - Internal Platform development`. Optimiser work moved from FPS (June) to JLP (early July) and back. Worth deciding a rule, since this feeds grant and customer cost allocation:
  * Optimiser, Nexus, cloning, dashboards → FPS - Internal Platform development
  * FCMS, Overload Limiter, JLP onboarding → JLP/ Waitrose Customer projects
* **Recurring typos:** `flextircity`, `Optmiser`, `Optimser`, `Onbaorded`, `Tom tom` (vs TomTom), `archg`, one trailing space after `Optimiser updates`.
* **Mixed casing in June:** five entries start lowercase (`optimiser testing`, `scheduler testing`). Jul–Aug are consistent.
* **Repeated wording:** `optimiser testing` appears twice on separate days, and `Steve testing` and `Testing` give little detail for audit or grant reporting. A specific object (what was tested, why) is more defensible.
* **Day-to-day continuity is visible**: `Continued…`, `Progressed…` entries signal multi-day work. That is a good habit and shows effort on long tasks.
* **Only 4 projects used out of ~30** on the Codes list. Nothing on Admin codes (sales, process, marketing) or R&D codes beyond Internal Platform. If you do any of that work it's probably being absorbed into other codes.

## 8. Template

```text
DOW | Date | 8 | | | | =SUM | <Project from Codes list> | <Verb> <system> <specific thing>
```

Example row:

```text
Tuesday | 18-Aug-26 | 8 | | | | 8 | JLP/ Waitrose Customer projects | Updated overload limiter integration plan
```
