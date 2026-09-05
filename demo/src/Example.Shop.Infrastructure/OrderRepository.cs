using Example.Shop.Domain;

namespace Example.Shop.Infrastructure;

public sealed class OrderRepository(string connectionString)
{
    public string ConnectionString { get; } = connectionString;

    public Order Sample() => new(1, "Example Retail", 42.00m);
}
