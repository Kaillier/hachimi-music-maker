using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using OpenUtau.Classic;
using OpenUtau.Core;
using OpenUtau.Core.Format;
using OpenUtau.Core.Render;
using OpenUtau.Core.Ustx;
using OpenUtau.Core.Util;

internal sealed class RenderRequest
{
    public string voicebank { get; set; } = "";
    public string sourceUstx { get; set; } = "";
    public string backing { get; set; } = "";
    public string output { get; set; } = "";
    public string ustx { get; set; } = "";
    public string[] sequence { get; set; } = [];
    public string sequenceMode { get; set; } = "pattern";
    public double rangeStart { get; set; }
    public double rangeEnd { get; set; }
    public double backingGain { get; set; } = 1;
    public double soundGain { get; set; } = 1;
    public string? originalAudio { get; set; }
    public int[] mutedUnits { get; set; } = [];
    public double[][] originalRanges { get; set; } = [];
}

internal sealed record SustainRestart(int PartIndex, int NoteIndex, int Position, int? GapTicks, string Alias);

// OpenUtau routes phonemizer results and export errors back to its UI scheduler.
// A pumped synchronization context preserves that contract without a GUI.
internal sealed class WorkerContext : SynchronizationContext, ICmdSubscriber
{
    private readonly ConcurrentQueue<Action> pending = new();
    private Exception? failure;
    public override void Post(SendOrPostCallback callback, object? state) => pending.Enqueue(() => callback(state));
    public void Pump()
    {
        while (pending.TryDequeue(out var callback)) callback();
        if (failure != null) throw failure;
    }
    public void OnNext(UCommand cmd, bool isUndo)
    {
        if (cmd is ErrorMessageNotification error)
        {
            failure = new InvalidOperationException(error.ToString(),
                error.e is MessageCustomizableException custom ? custom.SubstanceException : error.e);
        }
    }
    public void Wait(Task task)
    {
        var deadline = DateTime.UtcNow.AddMinutes(10);
        while (!task.IsCompleted)
        {
            Pump();
            if (DateTime.UtcNow > deadline) throw new TimeoutException("OpenUtau export timed out.");
            Thread.Sleep(10);
        }
        Pump();
        task.GetAwaiter().GetResult();
    }
}

internal static class Program
{
    private const int Rate = 44100;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static int Main(string[] args)
    {
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length > 1 && args[0] == "--generate-frq")
            {
                foreach (var wav in args.Skip(1)) GenerateFrq(wav);
                return 0;
            }
            var context = new WorkerContext();
            SynchronizationContext.SetSynchronizationContext(context);
            DocManager.Inst.Initialize(Thread.CurrentThread, TaskScheduler.FromCurrentSynchronizationContext());
            DocManager.Inst.PostOnUIThread = action => context.Post(_ => action(), null);
            DocManager.Inst.AddSubscriber(context);
            ToolsManager.Inst.Initialize();
            Directory.CreateDirectory(PathManager.Inst.CachePath);
            if (args.Length == 1 && args[0] == "--probe")
            {
                Console.WriteLine(JsonSerializer.Serialize(new { ok = true, renderer = Renderers.WORLDLINER }));
                return 0;
            }
            if (args.Length != 2 || args[0] != "--request")
                throw new ArgumentException("Usage: Hachimi.OpenUtau.Native.exe --request request.json");
            var request = JsonSerializer.Deserialize<RenderRequest>(File.ReadAllText(args[1]), JsonOptions)
                ?? throw new InvalidDataException("Invalid render request.");
            var sustainRestarts = new List<SustainRestart>();
            var project = BuildImportedProject(request, out var syllables, sustainRestarts);
            DocManager.Inst.ExecuteCmd(new LoadProjectNotification(project));
            project.ValidateFull();
            var parts = project.parts.OfType<UVoicePart>().ToArray();
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (parts.Any(part => !part.PhonemesUpToDate))
            {
                context.Pump();
                if (DateTime.UtcNow > deadline) throw new TimeoutException("OpenUtau phonemizer timed out.");
                Thread.Sleep(10);
            }
            project.Validate(new ValidateOptions { SkipTiming = true, SkipPhonemizer = true });
            if (parts.Sum(part => part.renderPhrases.Count) == 0 || parts.Any(part => part.phonemes.Any(phone => phone.Error)))
                throw new InvalidOperationException("OpenUtau produced missing or invalid phonemes.");
            Directory.CreateDirectory(Path.GetDirectoryName(request.output)!);
            if (File.Exists(request.ustx)) throw new IOException("Refusing to overwrite an existing USTX output.");
            Ustx.Save(request.ustx, project);
            context.Pump();
            var vocalPath = request.output + ".vocal.wav";
            if (File.Exists(vocalPath) || File.Exists(request.output))
                throw new IOException("Refusing to reuse an existing render output.");
            context.Wait(PlaybackManager.Inst.RenderMixdown(project, vocalPath));
            var rms = CheckVocal(vocalPath, allowSilence: request.mutedUnits.Length == syllables);
            MixRange(vocalPath, request);
            var report = new { ok = true, renderer = Renderers.WORLDLINER,
                units = syllables,
                request.mutedUnits, request.originalRanges,
                sustainRestarts,
                notes = parts.Sum(part => part.notes.Count), sourceUstx = request.sourceUstx,
                vocalRms = rms, start = request.rangeStart, end = request.rangeEnd, output = request.output, ustx = request.ustx };
            File.WriteAllText(request.output + ".json", JsonSerializer.Serialize(report));
            Console.WriteLine(JsonSerializer.Serialize(report));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static UProject BuildImportedProject(RenderRequest request, out int syllableCount, List<SustainRestart> sustainRestarts)
    {
        if (request.sequence.Length == 0 || request.sequence.Any(string.IsNullOrWhiteSpace))
            throw new InvalidDataException("An imported score requires a valid sound pattern.");
        if (string.IsNullOrWhiteSpace(request.sourceUstx))
            throw new InvalidDataException("A Vocal2Midi USTX score is required. Legacy analysis inputs are not supported.");
        if (request.sequenceMode is not ("pattern" or "units"))
            throw new InvalidDataException("Unknown sequence mode.");
        if (request.rangeStart != 0)
            throw new InvalidDataException("Imported USTX rendering must start at song time zero.");
        if (Path.GetFullPath(request.sourceUstx).Equals(Path.GetFullPath(request.ustx), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The imported score must not be overwritten.");
        foreach (var gain in new[] { request.backingGain, request.soundGain })
            if (!double.IsFinite(gain) || gain < 0 || gain > 1.5) throw new InvalidDataException("Invalid gain.");

        var project = Ustx.Load(request.sourceUstx);
        var parts = project.parts.OfType<UVoicePart>().OrderBy(part => part.position).ToArray();
        if (parts.Length == 0 || project.parts.Any(part => part is not UVoicePart))
            throw new InvalidDataException("The imported score must contain voice parts only.");
        if (parts.Select(part => part.trackNo).Distinct().Count() != 1)
            throw new InvalidDataException("Select a single vocal track before replacing lyrics.");
        var unitCount = parts.Sum(part => part.notes.Count(note => !note.lyric.StartsWith("+") && note.lyric != "-"));
        if (request.sequenceMode == "units" && request.sequence.Length != unitCount)
            throw new InvalidDataException("The sound sequence does not match the USTX syllable count.");
        var mutedUnits = request.mutedUnits.ToHashSet();
        if (mutedUnits.Count != request.mutedUnits.Length || mutedUnits.Any(index => index < 0 || index >= unitCount) ||
            (mutedUnits.Count > 0 && (request.sequenceMode != "units" || string.IsNullOrEmpty(request.originalAudio))) ||
            (mutedUnits.Count > 0) != (request.originalRanges.Length > 0))
            throw new InvalidDataException("Invalid original-audio selection.");
        if (request.rangeEnd == 0)
            request.rangeEnd = project.timeAxis.TickPosToMsPos(parts.Max(part => part.End)) / 1000.0 + 0.5;
        if (!double.IsFinite(request.rangeEnd) || request.rangeEnd <= 0)
            throw new InvalidDataException("Invalid imported render range.");
        var previousRangeEnd = 0.0;
        foreach (var range in request.originalRanges)
        {
            if (range.Length != 2 || !double.IsFinite(range[0]) || !double.IsFinite(range[1]) ||
                range[0] < previousRangeEnd || range[1] <= range[0] || range[1] > request.rangeEnd + 1.0 / Rate)
                throw new InvalidDataException("Invalid original-audio range.");
            previousRangeEnd = range[1];
        }
        var lastNoteTick = parts.Max(part => part.position + (part.notes.LastOrDefault()?.End ?? 0));
        if (request.rangeEnd + 0.1 < project.timeAxis.TickPosToMsPos(lastNoteTick) / 1000.0)
            throw new InvalidDataException("The selected accompaniment is shorter than the USTX score. Select the matching song.");

        var info = new Voicebank { File = Path.Combine(request.voicebank, "character.txt"),
            BasePath = Directory.GetParent(Path.GetFullPath(request.voicebank))!.FullName };
        VoicebankLoader.LoadVoicebank(info);
        var singer = new ClassicSinger(info);
        singer.EnsureLoaded();
        if (!singer.Loaded) throw new InvalidOperationException("OpenUtau could not load the supplied voicebank.");
        foreach (var alias in request.sequence.Distinct())
            if (!singer.TryGetOto(alias, out var oto) || !File.Exists(oto.File))
                throw new InvalidDataException($"The selected sound '{alias}' is missing from the voicebank.");
        foreach (var track in project.tracks)
        {
            track.Singer = singer;
            track.Phonemizer = new DefaultPhonemizer();
            track.RendererSettings.renderer = Renderers.WORLDLINER;
            track.RendererSettings.resampler = "worldline";
            track.RendererSettings.wavtool = "convergence";
        }
        var syllable = 0;
        string? currentAlias = null;
        foreach (var part in parts)
        {
            UNote? previous = null;
            var noteIndex = 0;
            foreach (var note in part.notes)
            {
                var startsPhoneme = false;
                if (note.lyric.StartsWith("+") || note.lyric == "-")
                {
                    if (currentAlias == null)
                        throw new InvalidDataException("A sustain note has no preceding syllable to continue.");
                    if (previous != null && previous.End > note.position)
                        throw new InvalidDataException("Overlapping sustain notes require correction in the source score; timing was not changed.");
                    if (previous == null || previous.End < note.position)
                    {
                        // OpenUtau's default phonemizer only links adjacent notes.
                        // Rearticulate the same alias across a rest, never stretch it.
                        sustainRestarts.Add(new SustainRestart(Array.IndexOf(parts, part), noteIndex,
                            part.position + note.position, previous == null ? null : note.position - previous.End, currentAlias));
                        note.lyric = currentAlias;
                        startsPhoneme = true;
                    }
                    else if (note.lyric == "-") note.lyric = "+";
                }
                else
                {
                    currentAlias = request.sequence[syllable++ % request.sequence.Length];
                    note.lyric = currentAlias;
                    startsPhoneme = true;
                }
                if (startsPhoneme && mutedUnits.Contains(syllable - 1))
                {
                    note.phonemeExpressions.RemoveAll(exp => exp.abbr == Ustx.VOL && exp.index == 0);
                    note.phonemeExpressions.Add(new UExpression(project.expressions[Ustx.VOL]) { index = 0, value = 0 });
                }
                previous = note;
                noteIndex++;
            }
        }
        if (syllable == 0) throw new InvalidDataException("The imported score contains no syllables.");
        syllableCount = syllable;
        Console.WriteLine($"Imported USTX: {parts.Sum(part => part.notes.Count)} notes, {syllable} replacement syllables, {sustainRestarts.Count} sustain rearticulations; preserved note timing and score pitch curves.");
        return project;
    }


    private static void GenerateFrq(string path)
    {
        using var wave = OpenUtau.Core.Format.Wave.OpenFile(path);
        if (wave.WaveFormat.SampleRate != Rate)
            throw new InvalidDataException($"FRQ generation requires a {Rate} Hz WAV: {path}");
        var provider = wave.ToSampleProvider();
        if (provider.WaveFormat.Channels == 2) provider = provider.ToMono(1, 0);
        var samples = OpenUtau.Core.Format.Wave.GetSamples(provider);
        var step = Frq.kHopSize * 1000.0 / Rate;
        var f0 = Worldline.F0(samples, Rate, step, 2)
            ?? throw new InvalidOperationException($"OpenUtau could not estimate sample F0: {path}");
        if (!f0.Any(value => value > 0))
            f0 = Worldline.F0(samples, Rate, step, 1) ?? f0;
        using var file = File.Create(VoicebankFiles.GetFrqFile(path));
        Frq.Build(samples, f0).Save(file);
        Console.WriteLine($"Generated FRQ: {Path.GetFileName(path)} ({f0.Count(value => value > 0)} voiced frames)");
    }

    private static double CheckVocal(string path, bool allowSilence)
    {
        using var reader = new WaveFileReader(path);
        if (reader.WaveFormat.SampleRate != Rate) throw new InvalidDataException("Unexpected OpenUtau sample rate.");
        var samples = reader.ToSampleProvider();
        var buffer = new float[8192];
        double energy = 0;
        long count = 0;
        int read;
        while ((read = samples.Read(buffer, 0, buffer.Length)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                if (!float.IsFinite(buffer[i])) throw new InvalidDataException("Non-finite OpenUtau output.");
                energy += buffer[i] * buffer[i];
            }
            count += read;
        }
        var rms = Math.Sqrt(energy / Math.Max(1, count));
        if (rms < 1e-7 && !allowSilence) throw new InvalidDataException("OpenUtau returned a silent vocal track.");
        return rms;
    }

    private static void MixRange(string vocalPath, RenderRequest request)
    {
        using var backingReader = new WaveFileReader(request.backing);
        using var vocalReader = new WaveFileReader(vocalPath);
        using var originalReader = request.originalRanges.Length > 0 ? new WaveFileReader(request.originalAudio!) : null;
        if (backingReader.WaveFormat.SampleRate != Rate)
            throw new InvalidDataException("Accompaniment must be 44100 Hz.");
        var start = (long)Math.Round(request.rangeStart * Rate);
        var length = (long)Math.Round(request.rangeEnd * Rate) - start;
        backingReader.Position = Math.Min(backingReader.Length, start * backingReader.WaveFormat.BlockAlign);
        vocalReader.Position = 0;
        ISampleProvider backing = backingReader.ToSampleProvider();
        ISampleProvider vocal = vocalReader.ToSampleProvider();
        if (backing.WaveFormat.Channels == 1) backing = new MonoToStereoSampleProvider(backing);
        if (vocal.WaveFormat.Channels == 1) vocal = new MonoToStereoSampleProvider(vocal);
        if (backing.WaveFormat.Channels != 2 || vocal.WaveFormat.Channels != 2)
            throw new InvalidDataException("Unsupported channel layout.");
        ISampleProvider? original = originalReader?.ToSampleProvider();
        if (original?.WaveFormat.Channels == 1) original = new MonoToStereoSampleProvider(original);
        if (original != null && (original.WaveFormat.SampleRate != Rate || original.WaveFormat.Channels != 2))
            throw new InvalidDataException("Original audio must be 44100 Hz mono or stereo.");
        var ranges = request.originalRanges.Select(range => (Start: (long)Math.Round(range[0] * Rate),
            End: Math.Min(length, (long)Math.Round(range[1] * Rate)))).ToArray();
        var rangeIndex = 0;
        const int FadeFrames = Rate / 200;
        var a = new float[8192];
        var b = new float[8192];
        var c = original == null ? null : new float[8192];
        using var writer = new WaveFileWriter(request.output, new WaveFormat(Rate, 16, 2));
        for (long frame = 0; frame < length; frame += a.Length / 2)
        {
            var count = (int)Math.Min(a.Length, (length - frame) * 2);
            Array.Clear(a);
            Array.Clear(b);
            backing.Read(a, 0, count);
            vocal.Read(b, 0, count);
            for (var i = 0; i < count; i++)
                a[i] = Math.Clamp(a[i] * (float)request.backingGain + b[i] * (float)request.soundGain, -1f, 1f);
            if (original != null)
            {
                if (original.Read(c!, 0, count) != count) throw new InvalidDataException("Original audio ended before the accompaniment.");
                for (var i = 0; i < count; i += 2)
                {
                    var position = frame + i / 2;
                    while (rangeIndex < ranges.Length && position >= ranges[rangeIndex].End) rangeIndex++;
                    if (rangeIndex >= ranges.Length) break;
                    var (left, right) = ranges[rangeIndex];
                    if (position < left) continue;
                    var blend = Math.Min(1f, Math.Min(left == 0 ? FadeFrames : position - left,
                        right == length ? FadeFrames : right - position - 1) / (float)FadeFrames);
                    a[i] = a[i] * (1 - blend) + c![i] * blend;
                    a[i + 1] = a[i + 1] * (1 - blend) + c![i + 1] * blend;
                }
            }
            writer.WriteSamples(a, 0, count);
        }
    }
}
