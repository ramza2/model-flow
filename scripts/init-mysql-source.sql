CREATE TABLE customers (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    segment VARCHAR(64) NOT NULL,
    lifetime_value DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO customers (name, email, segment, lifetime_value)
VALUES
    ('Ada Lovelace', 'ada@example.com', 'enterprise', 12500.00),
    ('Grace Hopper', 'grace@example.com', 'growth', 7200.50),
    ('Alan Turing', 'alan@example.com', 'starter', 1800.75);
