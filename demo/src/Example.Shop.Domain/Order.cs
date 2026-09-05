using Newtonsoft.Json;

namespace Example.Shop.Domain;

public sealed record Order(int Id, string Customer, decimal Total)
{
    public string ToJson() => JsonConvert.SerializeObject(this);
}
