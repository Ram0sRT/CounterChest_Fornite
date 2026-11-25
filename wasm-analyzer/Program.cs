using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Unreal.Core.Models.Enums;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ReplayAnalysisResult))]
internal partial class ReplayJsonContext : JsonSerializerContext { }

internal sealed class ReplayAnalysisResult
{
    public bool Ok { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string? Timestamp { get; set; }
    public uint LengthMs { get; set; }
    public string? Branch { get; set; }
    public bool RecorderFound { get; set; }
    public int MyOpened { get; set; }
    public int MyBroken { get; set; }
    public int MyTotal { get; set; }
    public int SquadOpened { get; set; }
    public int SquadBroken { get; set; }
    public int SquadTotal { get; set; }
    public string? Error { get; set; }
}

public static partial class ReplayApi
{
    public static void Main() { }

    [SupportedOSPlatform("browser")]
    [JSExport]
    public static string AnalyzeReplay(byte[] bytes, string fileName)
    {
        try
        {
            var reader = new ChestAnalyzerReader(ParseMode.Normal);
            using var stream = new MemoryStream(bytes);
            var replay = reader.ReadReplay(stream);
            reader.CreditBuildingCollapses();

            var me = reader.Me;
            var chestEvents = reader.Events
                .Where(e => e.ClassName.Contains("Chest", StringComparison.OrdinalIgnoreCase))
                .ToList();

            bool IsMySquad(TrackedPlayer? p) =>
                p != null && me != null && (p == me || (me.Team != null && p.Team == me.Team));

            var myOpened = chestEvents.Count(e => e.Opener == me && !e.Destroyed);
            var myBroken = chestEvents.Count(e => e.Opener == me && e.Destroyed);
            var squadOpened = chestEvents.Count(e => IsMySquad(e.Opener) && !e.Destroyed);
            var squadBroken = chestEvents.Count(e => IsMySquad(e.Opener) && e.Destroyed);

            return JsonSerializer.Serialize(new ReplayAnalysisResult
            {
                Ok = true,
                FileName = fileName,
                Timestamp = replay?.Info?.Timestamp.ToString("o"),
                LengthMs = replay?.Info?.LengthInMs ?? 0,
                Branch = replay?.Header?.Branch,
                RecorderFound = reader.RecorderKnown,
                MyOpened = myOpened,
                MyBroken = myBroken,
                MyTotal = myOpened + myBroken,
                SquadOpened = squadOpened,
                SquadBroken = squadBroken,
                SquadTotal = squadOpened + squadBroken
            }, ReplayJsonContext.Default.ReplayAnalysisResult);
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new ReplayAnalysisResult
            {
                Ok = false,
                FileName = fileName,
                Error = ex.Message
            }, ReplayJsonContext.Default.ReplayAnalysisResult);
        }
    }
}
