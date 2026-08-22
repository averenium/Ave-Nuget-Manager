using Ave.Nexus.Private;
using Newtonsoft.Json.Linq;

var json = JObject.FromObject(new { marker = Marker.Id });
Console.WriteLine(json);
