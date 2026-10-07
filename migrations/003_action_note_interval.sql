-- Actions : note d'accompagnement (affichée au parent) et délai minimum entre deux validations pour un même enfant
-- (ex. « une fois par nuit » = 12 h). NULL = aucune limite. Les deux sont modifiables par les parents.
ALTER TABLE actions
  ADD COLUMN note text NOT NULL DEFAULT '',
  ADD COLUMN min_interval_hours smallint CHECK (min_interval_hours IS NULL OR min_interval_hours BETWEEN 1 AND 72);
