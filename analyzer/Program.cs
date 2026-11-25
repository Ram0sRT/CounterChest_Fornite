using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Text.Json;
using FortniteReplayReader.Models.Events;
using FortniteReplayReader.Models.NetFieldExports;
using Unreal.Core;
using Unreal.Core.Contracts;
using Unreal.Core.Models;
using Unreal.Core.Models.Enums;

if (args.Length == 0)
{
    Console.Error.WriteLine("Uso: ReplayChestAnalyzer <ruta-al-archivo.replay>");
    return 1;
}

var replayPath = Path.GetFullPath(args[0]);
if (!File.Exists(replayPath))
{
    Console.Error.WriteLine($"Archivo no encontrado: {replayPath}");
    return 1;
}

try
{
    var bytes = File.ReadAllBytes(replayPath);
    var reader = new ChestAnalyzerReader(ParseMode.Normal);
    using var stream = new MemoryStream(bytes);
    var replay = reader.ReadReplay(stream);
    reader.CreditBuildingCollapses();

    var me = reader.Me;
    var chestEvents = reader.Events
        .Where(e => e.ClassName.Contains("Chest", StringComparison.OrdinalIgnoreCase))
        .ToList();

    bool IsMySquad(TrackedPlayer? p) => p != null && me != null && (p == me || (me.Team != null && p.Team == me.Team));

    var myOpened = chestEvents.Count(e => e.Opener == me && !e.Destroyed);
    var myBroken = chestEvents.Count(e => e.Opener == me && e.Destroyed);
    var squadOpened = chestEvents.Count(e => IsMySquad(e.Opener) && !e.Destroyed);
    var squadBroken = chestEvents.Count(e => IsMySquad(e.Opener) && e.Destroyed);
    var unattributedDestroyed = chestEvents.Count(e => e.Destroyed && e.Opener == null && e.NoPawn && e.InView);

    var result = new
    {
        fileName = Path.GetFileName(replayPath),
        timestamp = replay?.Info?.Timestamp.ToString("o"),
        lengthMs = replay?.Info?.LengthInMs ?? 0,
        branch = replay?.Header?.Branch,
        recorderFound = reader.RecorderKnown,
        recorderEpicId = me?.EpicId,
        recorderTeam = me?.Team,
        myOpened,
        myBroken,
        myTotal = myOpened + myBroken,
        squadOpened,
        squadBroken,
        squadTotal = squadOpened + squadBroken,
        unattributedDestroyed,
        totalChestEventsSeen = chestEvents.Count
    };

    Console.WriteLine(JsonSerializer.Serialize(result));
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 2;
}

sealed class TrackedPlayer
{
    public uint StateId { get; init; }
    public string? EpicId { get; set; }
    public int? Team { get; set; }
    public bool IsBot { get; set; }
    public FVector? Position { get; set; }
}

sealed class ChestLootEvent
{
    public double Time { get; init; }
    public string ClassName { get; init; } = string.Empty;
    public string? MapGroup { get; set; }
    public bool Destroyed { get; init; }
    public bool InView { get; set; }
    public bool NoPawn { get; set; }
    public TrackedPlayer? Opener { get; set; }
}

sealed class TrackedChestState
{
    public bool Searched { get; set; }
    public bool Destroyed { get; set; }
    public TrackedPlayer? Pawn { get; set; }
    public ChestLootEvent? PendingOpener { get; set; }
}

sealed class ChestAnalyzerReader : FortniteReplayReader.ReplayReader
{
    private const double CollapseMaxGapSeconds = 10.0;
    private const double SwingLookbackSeconds = 6.0;
    private const int MaxChannelOpensWithoutData = 100_000;

    private static readonly FieldInfo? NetGuidCacheField =
        typeof(FortniteReplayReader.ReplayReader).BaseType?
            .GetField("_netGuidCache", BindingFlags.Instance | BindingFlags.NonPublic);

    private enum ExportKind { None, Container, Pickaxe, Backpack }

    public Dictionary<uint, TrackedPlayer> Players { get; } = new();
    public List<ChestLootEvent> Events { get; } = new();

    private readonly Dictionary<string, TrackedChestState> chests = new();
    private readonly Dictionary<uint, string> channelKeys = new();
    private readonly Dictionary<uint, uint> channelToActor = new();
    private readonly Dictionary<uint, uint> pawnToState = new();
    private readonly Dictionary<string, ExportKind> exportKinds = new();
    private readonly HashSet<uint> freshChannels = new();
    private readonly Dictionary<uint, uint> channelOwner = new();
    private readonly List<(double Time, uint Pawn)> pickaxeSwings = new();
    private readonly List<(double Time, uint Pawn, bool HasWhiteTiger)> spriteHistory = new();

    private uint recorderStateId;
    private double currentTime;
    private int opensSinceData;

    public ChestAnalyzerReader(ParseMode mode) : base(null!, mode) { }

    public bool RecorderKnown => recorderStateId != 0 && Players.ContainsKey(recorderStateId);
    public TrackedPlayer? Me => RecorderKnown ? Players[recorderStateId] : null;

    protected override void OnChannelOpened(uint channelIndex, NetworkGUID? actor)
    {
        if (++opensSinceData > MaxChannelOpensWithoutData)
        {
            opensSinceData = 0;
            throw new InvalidDataException("Corrupt packet: channel reopened repeatedly without payload.");
        }

        if (actor != null)
        {
            channelToActor[channelIndex] = actor.Value;
        }
        else
        {
            channelToActor.Remove(channelIndex);
        }

        channelKeys.Remove(channelIndex);
        channelOwner.Remove(channelIndex);
        freshChannels.Add(channelIndex);
        base.OnChannelOpened(channelIndex, actor);
    }

    protected override void OnExportRead(uint channelIndex, INetFieldExportGroup? exportGroup)
    {
        switch (exportGroup)
        {
            case GameState gs:
                currentTime = gs.ReplicatedWorldTimeSecondsDouble ?? gs.ReplicatedWorldTimeSeconds ?? currentTime;
                if (gs.RecorderPlayerState?.Value is > 0)
                {
                    recorderStateId = gs.RecorderPlayerState.Value;
                }
                break;

            case FortPlayerState fps when channelToActor.TryGetValue(channelIndex, out var stateActorId):
                if (!Players.TryGetValue(stateActorId, out var player))
                {
                    player = new TrackedPlayer { StateId = stateActorId };
                    Players[stateActorId] = player;
                }
                player.EpicId = fps.UniqueId ?? fps.UniqueID ?? player.EpicId;
                player.Team = fps.TeamIndex ?? player.Team;
                player.IsBot |= fps.bIsABot == true;
                break;

            case PlayerPawn pawn when channelToActor.TryGetValue(channelIndex, out var pawnId):
                if (pawn.PlayerState is > 0)
                {
                    pawnToState[pawnId] = pawn.PlayerState.Value;
                }
                if (pawn.ReplicatedMovement is { } movement && PlayerOfPawn(pawnId) is { } owner)
                {
                    owner.Position = movement.Location;
                }
                break;
        }

        base.OnExportRead(channelIndex, exportGroup);
    }

    public override bool ReceiveProperties(
        FBitArchive archive,
        NetFieldExportGroup group,
        uint channelIndex,
        out INetFieldExportGroup? exportGroup,
        bool enablePropertyChecksum = true,
        bool netDeltaUpdate = false)
    {
        opensSinceData = 0;
        var kind = netDeltaUpdate || Channels[channelIndex] is null ? ExportKind.None : ClassifyGroup(group);
        if (kind == ExportKind.None)
        {
            return base.ReceiveProperties(archive, group, channelIndex, out exportGroup, enablePropertyChecksum, netDeltaUpdate);
        }

        exportGroup = null;
        if (enablePropertyChecksum)
        {
            archive.ReadBit();
        }

        bool? searched = null;
        bool? destroyed = null;
        uint? searchingPawn = null;
        uint? ownerPawn = null;
        uint? spriteDef = null;
        bool pickaxeSwung = false;

        while (true)
        {
            if (archive.IsError)
            {
                return false;
            }

            var handle = archive.ReadIntPacked();
            if (handle == 0)
            {
                break;
            }

            handle--;
            if (!group.IsValidIndex(handle))
            {
                return false;
            }

            var export = group.NetFieldExports[handle];
            var numBits = (int)archive.ReadIntPacked();
            if (numBits == 0)
            {
                continue;
            }

            var bitsLeftBefore = archive.GetBitsLeft();
            switch (export?.Name)
            {
                case "bAlreadySearched":
                    searched = archive.ReadBit();
                    break;
                case "bDestroyed":
                    destroyed = archive.ReadBit();
                    break;
                case "SearchingPawn":
                    searchingPawn = archive.ReadIntPacked();
                    break;
                case "Owner":
                    ownerPawn = archive.ReadIntPacked();
                    break;
                case "ExtractableItemDefinition":
                    spriteDef = archive.ReadIntPacked();
                    break;
                case "BlendingOutPawnMontage":
                    pickaxeSwung = true;
                    break;
            }

            var bitsConsumed = bitsLeftBefore - archive.GetBitsLeft();
            if (numBits > bitsConsumed)
            {
                archive.SkipBits(numBits - bitsConsumed);
            }
        }

        switch (kind)
        {
            case ExportKind.Container:
                HandleContainerUpdate(channelIndex, group.PathName, searched, destroyed, searchingPawn);
                break;
            case ExportKind.Pickaxe:
                HandlePickaxeUpdate(channelIndex, ownerPawn, pickaxeSwung);
                break;
            case ExportKind.Backpack:
                HandleBackpackUpdate(channelIndex, ownerPawn, spriteDef);
                break;
        }

        return true;
    }

    public override NetFieldExport? ReadNetFieldExport(FArchive archive)
    {
        var export = base.ReadNetFieldExport(archive);
        if (export?.Name is "bAlreadySearched" or "SearchingPawn")
        {
            exportKinds.Clear();
        }
        return export;
    }

    private ExportKind ClassifyGroup(NetFieldExportGroup group)
    {
        if (exportKinds.TryGetValue(group.PathName, out var cached))
        {
            return cached;
        }

        var path = group.PathName;
        var kind = group.NetFieldExports.Any(e => e?.Name is "bAlreadySearched" or "SearchingPawn")
            ? ExportKind.Container
            : path.Contains("ExtractionBackpack", StringComparison.Ordinal)
                ? ExportKind.Backpack
                : path.Contains("Pickaxe", StringComparison.Ordinal)
                    ? ExportKind.Pickaxe
                    : ExportKind.None;

        return exportKinds[path] = kind;
    }

    private void HandlePickaxeUpdate(uint channelIndex, uint? ownerPawn, bool swung)
    {
        var isInitialLoad = freshChannels.Remove(channelIndex);
        if (ownerPawn is > 0)
        {
            channelOwner[channelIndex] = ownerPawn.Value;
        }
        if (swung && !isInitialLoad && channelOwner.TryGetValue(channelIndex, out var pawn))
        {
            pickaxeSwings.Add((currentTime, pawn));
        }
    }

    private void HandleBackpackUpdate(uint channelIndex, uint? ownerPawn, uint? spriteDef)
    {
        freshChannels.Remove(channelIndex);
        if (ownerPawn is > 0)
        {
            channelOwner[channelIndex] = ownerPawn.Value;
        }
        if (spriteDef is > 0 && channelOwner.TryGetValue(channelIndex, out var pawn))
        {
            var hasTiger = PathOf(spriteDef.Value)?.Contains("WhiteTiger", StringComparison.Ordinal) == true;
            spriteHistory.Add((currentTime, pawn, hasTiger));
        }
    }

    private void HandleContainerUpdate(uint channelIndex, string classPath, bool? searched, bool? destroyed, uint? searchingPawn)
    {
        var className = classPath[(classPath.LastIndexOf('.') + 1)..];
        var key = ResolveChestKey(channelIndex, className);
        if (!chests.TryGetValue(key, out var chest))
        {
            chest = new TrackedChestState();
            chests[key] = chest;
        }

        var isInitialLoad = freshChannels.Remove(channelIndex);
        if (isInitialLoad && searchingPawn == null)
        {
            chest.Pawn = null;
        }

        if (searchingPawn != null)
        {
            chest.Pawn = searchingPawn > 0 ? PlayerOfPawn(searchingPawn.Value) : null;
            if (chest.PendingOpener != null && chest.Pawn != null)
            {
                chest.PendingOpener.Opener = chest.Pawn;
                chest.PendingOpener = null;
            }
        }

        if (searched == false)
        {
            chest.Searched = false;
            chest.PendingOpener = null;
        }

        if (destroyed == false)
        {
            chest.Destroyed = false;
        }

        ChestLootEvent? created = null;
        if (searched == true && !chest.Searched)
        {
            chest.Searched = true;
            created = new ChestLootEvent
            {
                Time = currentTime,
                ClassName = className,
                Opener = chest.Pawn
            };
        }

        if (destroyed == true && !chest.Destroyed)
        {
            chest.Destroyed = true;
            if (!chest.Searched && created == null)
            {
                created = new ChestLootEvent
                {
                    Time = currentTime,
                    ClassName = className,
                    Destroyed = true,
                    Opener = searchingPawn is > 0 ? chest.Pawn : null
                };
            }
        }

        if (created != null)
        {
            created.MapGroup = ExtractMapGroup(key);
            created.NoPawn = searchingPawn == null;
            created.InView = !isInitialLoad;
            Events.Add(created);

            if (created.Opener == null && !created.Destroyed && created.InView)
            {
                chest.PendingOpener = created;
            }
        }
    }

    public void CreditBuildingCollapses()
    {
        var me = Me;
        if (me == null)
        {
            return;
        }

        var orphanDestructions = Events
            .Where(e => e.Destroyed && e.Opener == null && e.NoPawn && e.InView && e.MapGroup != null)
            .OrderBy(e => e.Time)
            .GroupBy(e => e.MapGroup!);

        foreach (var group in orphanDestructions)
        {
            var burst = new List<ChestLootEvent>();
            foreach (var ev in group.Append<ChestLootEvent?>(null))
            {
                if (ev != null && (burst.Count == 0 || ev.Time - burst[^1].Time <= CollapseMaxGapSeconds))
                {
                    burst.Add(ev);
                    continue;
                }

                if (burst.Count >= 3)
                {
                    var cause = ResolveCollapseCause(burst[0].Time, me);
                    foreach (var item in burst)
                    {
                        item.Opener = cause;
                    }
                }

                burst.Clear();
                if (ev != null)
                {
                    burst.Add(ev);
                }
            }
        }
    }

    private TrackedPlayer? ResolveCollapseCause(double collapseStartTime, TrackedPlayer me)
    {
        bool InMySquad(TrackedPlayer p) => p == me || (me.Team != null && p.Team == me.Team);

        var activeTigers = spriteHistory
            .Where(s => s.Time <= collapseStartTime)
            .GroupBy(s => PlayerOfPawn(s.Pawn))
            .Where(g => g.Key != null && InMySquad(g.Key) && g.Last().HasWhiteTiger)
            .Select(g => g.Key!)
            .ToList();

        var recentSwingers = pickaxeSwings
            .Where(a => a.Time <= collapseStartTime && a.Time >= collapseStartTime - SwingLookbackSeconds)
            .Select(a => PlayerOfPawn(a.Pawn))
            .Where(p => p != null)
            .Cast<TrackedPlayer>()
            .ToList();

        var squadSwingers = recentSwingers.Where(InMySquad).ToList();
        if (squadSwingers.Count > 0)
        {
            return squadSwingers.LastOrDefault(activeTigers.Contains) ?? squadSwingers[^1];
        }

        if (recentSwingers.Count > 0)
        {
            return null;
        }

        if (activeTigers.Contains(me))
        {
            return me;
        }

        return activeTigers.Count == 1 ? activeTigers[0] : null;
    }

    private static string? ExtractMapGroup(string key)
    {
        var parts = key.Split('_');
        var idx = Array.IndexOf(parts, "UAID");
        return idx >= 0 && parts.Length - idx == 4 ? parts[idx + 2] : null;
    }

    private string ResolveChestKey(uint channelIndex, string className)
    {
        if (channelKeys.TryGetValue(channelIndex, out var cached))
        {
            return cached;
        }

        if (!channelToActor.TryGetValue(channelIndex, out var actorId))
        {
            return $"channel {channelIndex}";
        }

        var key = PathOf(actorId);
        if (key == null)
        {
            var location = Channels[channelIndex]?.Actor?.Location;
            key = location is not null
                ? $"{className} @{Math.Round(location.X / 100)},{Math.Round(location.Y / 100)}"
                : $"actor {actorId}";
        }

        return channelKeys[channelIndex] = key;
    }

    private string? PathOf(uint actorId)
    {
        var cache = NetGuidCacheField?.GetValue(this);
        var paths = cache?.GetType().GetProperty("NetGuidToPathName")?.GetValue(cache) as Dictionary<uint, string>;
        return paths != null && paths.TryGetValue(actorId, out var path) ? path : null;
    }

    private TrackedPlayer? PlayerOfPawn(uint pawnId)
    {
        return pawnToState.TryGetValue(pawnId, out var stateId) && Players.TryGetValue(stateId, out var player)
            ? player
            : null;
    }

    public override PlayerElimination ParseElimination(FArchive archive, Unreal.Core.Models.EventInfo info)
    {
        try
        {
            return base.ParseElimination(archive, info);
        }
        catch
        {
            return new PlayerElimination { Info = info };
        }
    }
}
