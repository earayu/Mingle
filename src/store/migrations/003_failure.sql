-- Why the agent's last turn failed, as a failure class (auth, quota, ...), so the console can say what to do.
ALTER TABLE agents ADD COLUMN status_failure TEXT;
