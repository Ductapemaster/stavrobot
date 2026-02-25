---
title: Gym tracking
description: Track workouts, exercises, body measurements, and view progress over time.
version: 1
author: Stavros Korokithakis
---

You are installing the gym tracking skill. Follow these steps in order.

## Step 1: Create the tables

Create the following tables if they do not already exist.

**`exercises`** — Exercise catalog.
- `name` (text, primary key) — e.g. "bench press", "squat"
- `notes` (text) — form cues, variations, equipment notes

**`workouts`** — A single gym session.
- `id` (serial, primary key)
- `date` (date)
- `notes` (text) — how the session felt, energy level, etc.
- `duration_minutes` (integer, nullable)

**`workout_sets`** — Individual sets within a workout.
- `id` (serial, primary key)
- `workout_id` (integer, references `workouts`)
- `exercise_name` (text, references `exercises`)
- `set_number` (integer)
- `reps` (integer)
- `weight` (numeric) — in whatever unit the user prefers
- `notes` (text) — e.g. "felt easy", "failed on last rep"

**`body_measurements`** — Body weight and other measurements over time.
- `id` (serial, primary key)
- `date` (date)
- `weight` (numeric, nullable)
- `body_fat_percentage` (numeric, nullable)
- `notes` (text)

## Step 2: Create the pages

Create the following three pages using `upsert_page`. All pages must be private (not public).

**`/pages/gym`** — Main dashboard.

Show the latest body measurement at the top of the page. Below that, list the most recent 10 workouts in reverse chronological order. For each workout, show the date, duration (if set), any notes, and a breakdown of every set performed: exercise name, set number, reps, weight, and set notes.

Define two named queries:
- `recent_workouts`: returns the 10 most recent workouts joined with their sets and the exercise name, ordered by workout date descending then by set number ascending.
- `latest_measurement`: returns the single most recent row from `body_measurements`.

**`/pages/gym/progress`** — Progress tracking.

Show two charts:
1. Body weight over time, plotted from all rows in `body_measurements` that have a non-null weight.
2. Weight progression for a selected exercise over time. The user picks an exercise from a dropdown; the chart updates to show the maximum weight lifted for that exercise per workout date.

Define three named queries:
- `body_weight_history`: returns all `body_measurements` rows with a non-null weight, ordered by date ascending.
- `exercise_list`: returns all exercise names from the `exercises` table, ordered alphabetically.
- `exercise_progress`: parameterized by exercise name; returns the maximum weight lifted for that exercise per workout date, ordered by date ascending.

**`/pages/gym/exercises`** — Exercise catalog.

Show a simple table listing all exercises with their name and notes, ordered alphabetically by name.

Define one named query:
- `all_exercises`: returns all rows from `exercises`, ordered by name ascending.

## Step 3: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "gym"
- `url`: "https://stavrobot.stavros.io/skills/gym.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
