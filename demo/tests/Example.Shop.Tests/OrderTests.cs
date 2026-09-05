using Example.Shop.Domain;
using Xunit;

namespace Example.Shop.Tests;

public class OrderTests
{
    [Fact]
    public void ToJson_includes_the_customer()
    {
        var order = new Order(1, "Example Retail", 42.00m);

        Assert.Contains("Example Retail", order.ToJson());
    }
}
