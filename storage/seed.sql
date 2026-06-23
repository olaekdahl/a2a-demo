-- Optional reference/seed data for Operation Echo Shield.
-- The live registry repopulates `agents`/`agent_cards` at runtime, so this file
-- is only static reference data used by docs/tests. Safe to run repeatedly.

-- Known galaxy reference rows are stored in a lightweight reference table that
-- is NOT part of the core protocol schema; it exists purely to make the demo
-- self-describing for anyone poking at the database directly.
CREATE TABLE IF NOT EXISTS reference_planets (
  name         TEXT PRIMARY KEY,
  region       TEXT,
  base         TEXT,
  threat_notes TEXT
);

INSERT OR REPLACE INTO reference_planets (name, region, base, threat_notes) VALUES
  ('Hoth',     'Outer Rim',  'Echo Base',   'Empire massing armor columns beyond the northern ridge.'),
  ('Dantooine','Outer Rim',  'Abandoned',   'Former Rebel base, now a fallback rendezvous.'),
  ('Yavin 4',  'Outer Rim',  'Great Temple','Historic Rebel staging ground.');

CREATE TABLE IF NOT EXISTS reference_skills (
  skill_id TEXT PRIMARY KEY,
  agent    TEXT,
  language TEXT
);

INSERT OR REPLACE INTO reference_skills (skill_id, agent, language) VALUES
  ('scout_system',             'intelligence-agent',          'typescript'),
  ('calculate_risk',           'tactical-agent',              'go'),
  ('assess_transport_capacity','logistics-agent',             'go'),
  ('relay_transmission',       'communications-relay-agent',  'typescript'),
  ('reinforce_planet',         'fleet-agent',                 'go');
