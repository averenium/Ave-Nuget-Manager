using Example.Shop.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient();
builder.Services.AddSingleton(new OrderRepository("Host=localhost;Database=example"));

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/orders/sample", (OrderRepository repository) => Results.Ok(repository.Sample()));

app.Run();
