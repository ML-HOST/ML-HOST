-- try.md "What to measure". Run: npx wrangler d1 execute locallink-try --remote --file queries.sql

-- Visitors per page
SELECT page, COUNT(DISTINCT session_id) AS visitors FROM events WHERE type = 'page_view' GROUP BY page;

-- % with WebGPU working, by device class
SELECT device_class, COUNT(*) AS checks, ROUND(100.0 * AVG(webgpu), 1) AS pct_webgpu
FROM events WHERE type = 'check_done' GROUP BY device_class;

-- % of visitors who ran locally and got an answer
SELECT page,
  ROUND(100.0 * COUNT(DISTINCT CASE WHEN type = 'run_done' AND mode = 'local' THEN session_id END)
        / COUNT(DISTINCT session_id), 1) AS pct_local_answer
FROM events GROUP BY page;

-- Crash rate on phones vs laptops: local sessions that hit an error / local sessions that started loading
SELECT device_class,
  COUNT(DISTINCT CASE WHEN type = 'error' AND mode = 'local' THEN session_id END) AS crashed,
  COUNT(DISTINCT CASE WHEN type = 'load_start' THEN session_id END) AS tried_local
FROM events GROUP BY device_class;

-- How many clicked cloud
SELECT page, COUNT(DISTINCT session_id) AS cloud_sessions, COUNT(*) AS cloud_calls
FROM events WHERE type = 'cloud_call' GROUP BY page;

-- Median-ish load time and speed, local
SELECT page, device_class, COUNT(*) AS loads, ROUND(AVG(load_ms)) AS avg_load_ms FROM events
WHERE type = 'load_done' GROUP BY page, device_class;
SELECT page, device_class, ROUND(AVG(tokens_per_sec), 1) AS avg_tps FROM events
WHERE type = 'run_done' AND mode = 'local' AND tokens_per_sec IS NOT NULL GROUP BY page, device_class;

-- Errors by code
SELECT page, mode, error_code, COUNT(*) AS n FROM events WHERE type = 'error' GROUP BY 1, 2, 3 ORDER BY n DESC;

-- Cloud calls used per day vs DAILY_CAP
SELECT * FROM usage ORDER BY day DESC LIMIT 14;
