CREATE TABLE public.customers (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    segment TEXT NOT NULL,
    lifetime_value NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.customers (name, email, segment, lifetime_value)
VALUES
    ('Ada Lovelace', 'ada@example.com', 'enterprise', 12500.00),
    ('Grace Hopper', 'grace@example.com', 'growth', 7200.50),
    ('Alan Turing', 'alan@example.com', 'starter', 1800.75);
