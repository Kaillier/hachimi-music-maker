using System.Collections.Concurrent;
using System.Globalization;
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
    public string analysis { get; set; } = "";
    public string sourceUstx { get; set; } = "";
    public string pitch { get; set; } = "";
    public string backing { get; set; } = "";
    public string output { get; set; } = "";
    public string ustx { get; set; } = "";
    public string[] sequence { get; set; } = [];
    public int[] unitIds { get; set; } = [];
    public double tempoBpm { get; set; } = 120;
    public double rangeStart { get; set; }
    public double rangeEnd { get; set; }
    public double backingGain { get; set; } = 1;
    public double soundGain { get; set; } = 1;
}

internal sealed class AnalysisFile
{
    public double duration { get; set; }
    public List<AnalysisUnit> units { get; set; } = [];
}

internal sealed class AnalysisUnit
{
    public int id { get; set; }
    public double start { get; set; }
    public double end { get; set; }
    public double midi { get; set; }
    public List<UnitNote> notes { get; set; } = [];
}

internal sealed class UnitNote
{
    public double start { get; set; }
    public double end { get; set; }
    public int midi { get; set; }
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
    private const int Resolution = 480;
    private static readonly string[] Aliases = ["ha", "ji", "mi", "man", "bo"];
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static int Main(string[] args)
    {
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            Console.OutputEncoding = new UTF8Encoding(false);
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
            UProject project;
            int? importedSyllables = null;
            var sustainRestarts = new List<SustainRestart>();
            if (!string.IsNullOrWhiteSpace(request.sourceUstx))
            {
                project = BuildImportedProject(request, out var syllables, sustainRestarts);
                importedSyllables = syllables;
            }
            else
            {
                var analysis = JsonSerializer.Deserialize<AnalysisFile>(File.ReadAllText(request.analysis), JsonOptions)
                    ?? throw new InvalidDataException("Invalid analysis.");
                Validate(request, analysis);
                project = BuildProject(request, analysis);
            }
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
            var rms = CheckVocal(vocalPath);
            MixRange(vocalPath, request);
            var report = new { ok = true, renderer = Renderers.WORLDLINER,
                units = importedSyllables ?? request.unitIds.Length,
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
        if (request.sequence.Length == 0 || request.sequence.Any(alias => !Aliases.Contains(alias)))
            throw new InvalidDataException("An imported score requires a valid sound pattern.");
        if (!string.IsNullOrWhiteSpace(request.pitch))
            throw new InvalidDataException("Imported USTX pitch must not be replaced by an external pitch track.");
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
        if (request.rangeEnd == 0)
            request.rangeEnd = project.timeAxis.TickPosToMsPos(parts.Max(part => part.End)) / 1000.0 + 0.5;
        if (!double.IsFinite(request.rangeEnd) || request.rangeEnd <= 0)
            throw new InvalidDataException("Invalid imported render range.");
        var lastNoteTick = parts.Max(part => part.position + (part.notes.LastOrDefault()?.End ?? 0));
        if (request.rangeEnd + 0.1 < project.timeAxis.TickPosToMsPos(lastNoteTick) / 1000.0)
            throw new InvalidDataException("The selected accompaniment is shorter than the USTX score. Select the matching song.");

        var info = new Voicebank { File = Path.Combine(request.voicebank, "character.txt"),
            BasePath = Directory.GetParent(Path.GetFullPath(request.voicebank))!.FullName };
        VoicebankLoader.LoadVoicebank(info);
        var singer = new ClassicSinger(info);
        singer.EnsureLoaded();
        if (!singer.Loaded) throw new InvalidOperationException("OpenUtau could not load the supplied voicebank.");
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
                    }
                    else if (note.lyric == "-") note.lyric = "+";
                }
                else
                {
                    currentAlias = request.sequence[syllable++ % request.sequence.Length];
                    note.lyric = currentAlias;
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

    private static void Validate(RenderRequest request, AnalysisFile analysis)
    {
        if (!double.IsFinite(request.tempoBpm) || request.tempoBpm <= 0 || request.tempoBpm > 400)
            throw new InvalidDataException("Invalid tempo.");
        if (request.unitIds.Length == 0) request.unitIds = analysis.units.Select(unit => unit.id).ToArray();
        if (request.sequence.Length != request.unitIds.Length || request.sequence.Length == 0 ||
            request.sequence.Any(alias => !Aliases.Contains(alias)) ||
            request.unitIds.Distinct().Count() != request.unitIds.Length)
            throw new InvalidDataException("Invalid sound sequence.");
        if (request.rangeEnd == 0) request.rangeEnd = analysis.duration;
        if (!double.IsFinite(request.rangeStart) || !double.IsFinite(request.rangeEnd) ||
            request.rangeStart < 0 || request.rangeEnd <= request.rangeStart || request.rangeEnd > analysis.duration + .001)
            throw new InvalidDataException("Invalid render range.");
        foreach (var gain in new[] { request.backingGain, request.soundGain })
            if (!double.IsFinite(gain) || gain < 0 || gain > 1.5) throw new InvalidDataException("Invalid gain.");
    }

    private static UProject BuildProject(RenderRequest request, AnalysisFile analysis)
    {
        (double time, double midi)[] pitches = string.IsNullOrWhiteSpace(request.pitch)
            ? []
            : File.ReadLines(request.pitch).Skip(1).Select(line => line.Split(','))
                .Select(cells => (time: double.Parse(cells[0], CultureInfo.InvariantCulture),
                    midi: double.Parse(cells[1], CultureInfo.InvariantCulture)))
                .Where(point => double.IsFinite(point.time) && double.IsFinite(point.midi)).ToArray();
        var project = Ustx.Create();
        project.name = "Hachimi arrangement";
        project.resolution = Resolution;
        project.tempos = [new UTempo(0, request.tempoBpm)];
        project.timeSignatures = [new UTimeSignature(0, 4, 4)];
        project.bpm = request.tempoBpm;
        project.beatPerBar = 4;
        project.beatUnit = 4;
        project.timeAxis.BuildSegments(project);
        var info = new Voicebank { File = Path.Combine(request.voicebank, "character.txt"),
            BasePath = Directory.GetParent(Path.GetFullPath(request.voicebank))!.FullName };
        VoicebankLoader.LoadVoicebank(info);
        var singer = new ClassicSinger(info);
        singer.EnsureLoaded();
        if (!singer.Loaded) throw new InvalidOperationException("OpenUtau could not load the supplied voicebank.");
        var track = project.tracks[0];
        track.TrackName = "Hachimi";
        track.Singer = singer;
        track.RendererSettings.renderer = Renderers.WORLDLINER;
        track.RendererSettings.resampler = "worldline";
        track.RendererSettings.wavtool = "convergence";
        var part = new UVoicePart { name = "Selected arrangement", position = 0 };
        var units = analysis.units.ToDictionary(unit => unit.id);
        var rangeStartTick = project.timeAxis.MsPosToTickPos(request.rangeStart * 1000);
        for (var i = 0; i < request.unitIds.Length; i++)
        {
            var unit = units[request.unitIds[i]];
            var noteSegments = unit.notes.Count > 0 ? unit.notes : [new UnitNote { start = unit.start, end = unit.end, midi = (int)Math.Round(unit.midi) }];
            var segmentIndex = 0;
            foreach (var segment in noteSegments)
            {
                var segmentStart = Math.Max(unit.start, Math.Min(unit.end, segment.start));
                var segmentEnd = Math.Min(unit.end, Math.Max(unit.start, segment.end));
                if (segmentEnd - segmentStart < 0.025) continue;
                var start = project.timeAxis.MsPosToTickPos(segmentStart * 1000) - rangeStartTick;
                var end = Math.Max(start + 1, project.timeAxis.MsPosToTickPos(segmentEnd * 1000) - rangeStartTick);
                var note = project.CreateNote(Math.Clamp(segment.midi, 0, 127), start, end - start);
                // OpenUtau USTX uses '+' (and '+N') for extender notes. A
                // repeated alias would retrigger the consonant of the sample.
                var canExtend = segmentIndex > 0 && part.notes.Count > 0 && part.notes.Last().End == start;
                note.lyric = canExtend ? "+" : request.sequence[i];
                segmentIndex++;
                // Preserve the first RMVPE point instead of snapping it to
                // the GAME note or the previous note.
                note.pitch = new UPitch { snapFirst = false };
                AddPitchCurve(note, pitches, segmentStart, segmentEnd);
                part.notes.Add(note);
                part.duration = Math.Max(part.duration, note.End);
            }
        }
        project.parts.Add(part);
        return project;
    }

    private static void AddPitchCurve(UNote note, (double time, double midi)[] pitches, double start, double end)
    {
        if (pitches.Length == 0) return;
        var durationMs = Math.Max(1.0, (end - start) * 1000.0);
        var points = pitches.Where(point => point.time >= start && point.time <= end).ToList();
        var boundary = new List<(double time, double midi)> { (start, InterpolatePitch(pitches, start)), (end, InterpolatePitch(pitches, end)) };
        boundary.AddRange(points);
        foreach (var point in boundary.OrderBy(point => point.time).GroupBy(point => Math.Round(point.time, 4)).Select(group => group.First()))
        {
            var relative = point.midi - note.tone;
            var x = (float)Math.Clamp((point.time - start) * 1000.0, 0.0, durationMs);
            note.pitch.AddPoint(new PitchPoint(x, (float)(relative * 10.0), PitchPointShape.l));
        }
        if (note.pitch.data.Count == 0)
        {
            note.pitch.AddPoint(new PitchPoint(0, 0, PitchPointShape.l));
            note.pitch.AddPoint(new PitchPoint((float)durationMs, 0, PitchPointShape.l));
        }
    }

    private static double InterpolatePitch((double time, double midi)[] pitches, double time)
    {
        if (pitches.Length == 0) return 60.0;
        if (time <= pitches[0].time) return pitches[0].midi;
        if (time >= pitches[^1].time) return pitches[^1].midi;
        for (var i = 1; i < pitches.Length; i++)
        {
            if (pitches[i].time < time) continue;
            var left = pitches[i - 1];
            var right = pitches[i];
            var ratio = (time - left.time) / Math.Max(1e-6, right.time - left.time);
            return left.midi + (right.midi - left.midi) * ratio;
        }
        return pitches[^1].midi;
    }

    private static double CheckVocal(string path)
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
        if (rms < 1e-7) throw new InvalidDataException("OpenUtau returned a silent vocal track.");
        return rms;
    }

    private static void MixRange(string vocalPath, RenderRequest request)
    {
        using var backingReader = new WaveFileReader(request.backing);
        using var vocalReader = new WaveFileReader(vocalPath);
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
        var a = new float[8192];
        var b = new float[8192];
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
            writer.WriteSamples(a, 0, count);
        }
    }
}
