using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Konscious.Security.Cryptography;

namespace Uc3.PinAccess;

internal static class Program
{
    private const string DefaultRemote = "10.0.10.51";

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = Options.Parse(args);
            if (options.SelfTest)
            {
                await SelfTest.RunAsync();
                Console.WriteLine("SSH PIN recovery self-test: PASS");
                return 0;
            }

            var source = new RemoteCredentialSource(options.Remote);
            var encodedHash = await source.ReadPasswordHashAsync();
            var passwordHash = Argon2PasswordHash.Parse(encodedHash);
            var pin = await PinRecovery.RecoverAsync(passwordHash, options.Workers);
            var certificate = await source.ReadTlsCertificateAsync();
            await WebConfigVerifier.VerifyAsync(options.Remote, pin, certificate);

            if (!options.VerifyOnly)
            {
                Console.WriteLine(pin);
            }

            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"uc3-pin: {exception.Message}");
            return 1;
        }
    }

    private sealed record Options(string Remote, int Workers, bool VerifyOnly, bool SelfTest)
    {
        public static Options Parse(string[] args)
        {
            var remote = DefaultRemote;
            var workers = Math.Min(Environment.ProcessorCount, 16);
            var verifyOnly = false;
            var selfTest = false;

            for (var index = 0; index < args.Length; index++)
            {
                switch (args[index])
                {
                    case "--remote" when index + 1 < args.Length:
                        remote = args[++index];
                        break;
                    case "--workers" when index + 1 < args.Length:
                        if (!int.TryParse(args[++index], CultureInfo.InvariantCulture, out workers))
                        {
                            throw new ArgumentException("--workers requires an integer");
                        }
                        break;
                    case "--verify-only":
                        verifyOnly = true;
                        break;
                    case "--self-test":
                        selfTest = true;
                        break;
                    default:
                        throw new ArgumentException($"unknown or incomplete option: {args[index]}");
                }
            }

            if (!IPAddress.TryParse(remote, out var address) ||
                address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
            {
                throw new ArgumentException("--remote must be an IPv4 address");
            }
            if (workers is < 1 or > 32)
            {
                throw new ArgumentException("--workers must be in the range 1 through 32");
            }
            if (selfTest && args.Any(argument => argument is "--remote" or "--verify-only"))
            {
                throw new ArgumentException("--self-test cannot access a remote");
            }

            return new Options(remote, workers, verifyOnly, selfTest);
        }
    }
}

internal sealed class RemoteCredentialSource(string remote)
{
    private const int MaximumSshOutput = 4096;

    public async Task<string> ReadPasswordHashAsync()
    {
        const string command =
            "sqlite3 /opt/uc/data/data/remote.db \"select password_hash from users " +
            "where username='web-configurator' and active=1;\"";
        var output = await RunSshAsync(command);
        string encoded;
        try
        {
            encoded = Encoding.ASCII.GetString(output).TrimEnd('\r', '\n');
        }
        finally
        {
            CryptographicOperations.ZeroMemory(output);
        }

        if (encoded.Length is < 40 or > 512 || encoded.Contains('\n') || encoded.Contains('\r'))
        {
            throw new InvalidOperationException(
                "Remote Core returned an unexpected web-configurator hash");
        }
        return encoded;
    }

    public Task<byte[]> ReadTlsCertificateAsync()
    {
        const string command =
            "openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null " +
            "| openssl x509 -outform DER";
        return RunSshAsync(command);
    }

    private async Task<byte[]> RunSshAsync(string command)
    {
        var startInfo = new ProcessStartInfo("ssh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[]
                 {
                     "-o", "BatchMode=yes",
                     "-o", "ConnectTimeout=8",
                     "-o", "LogLevel=ERROR",
                     $"root@{remote}",
                     command,
                 })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo) ??
            throw new InvalidOperationException("failed to start ssh");
        await using var output = new MemoryStream();
        var copy = process.StandardOutput.BaseStream.CopyToAsync(output);
        var error = process.StandardError.ReadToEndAsync();
        await Task.WhenAll(copy, process.WaitForExitAsync());
        var errorText = await error;
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"SSH command failed with exit code {process.ExitCode}: {errorText.Trim()}");
        }
        if (output.Length is 0 or > MaximumSshOutput)
        {
            throw new InvalidOperationException("SSH returned an unexpected amount of data");
        }
        return output.ToArray();
    }
}

internal sealed record Argon2PasswordHash(
    int MemorySize,
    int Iterations,
    int Parallelism,
    byte[] Salt,
    byte[] Digest)
{
    public static Argon2PasswordHash Parse(string encoded)
    {
        var parts = encoded.Split('$');
        if (parts.Length != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19")
        {
            throw new InvalidOperationException("unsupported Remote Core password hash format");
        }

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var parameter in parts[3].Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = parameter.Split('=', 2);
            if (pair.Length != 2 || !parameters.TryAdd(pair[0], pair[1]))
            {
                throw new InvalidOperationException("invalid Remote Core Argon2 parameters");
            }
        }
        if (parameters.Count != 3 ||
            !ReadParameter(parameters, "m", out var memorySize) ||
            !ReadParameter(parameters, "t", out var iterations) ||
            !ReadParameter(parameters, "p", out var parallelism) ||
            memorySize is < 8 or > 262_144 ||
            iterations is < 1 or > 100 ||
            parallelism is < 1 or > 64)
        {
            throw new InvalidOperationException("unsafe Remote Core Argon2 parameters");
        }

        var salt = DecodeBase64(parts[4]);
        var digest = DecodeBase64(parts[5]);
        if (salt.Length is < 8 or > 64 || digest.Length is < 16 or > 128)
        {
            throw new InvalidOperationException("unsafe Remote Core Argon2 hash size");
        }
        return new Argon2PasswordHash(memorySize, iterations, parallelism, salt, digest);
    }

    public async Task<bool> MatchesAsync(string candidate)
    {
        var password = Encoding.UTF8.GetBytes(candidate);
        try
        {
            using var argon2 = new Argon2id(password)
            {
                Salt = Salt,
                MemorySize = MemorySize,
                Iterations = Iterations,
                DegreeOfParallelism = Parallelism,
            };
            var computed = await argon2.GetBytesAsync(Digest.Length);
            try
            {
                return CryptographicOperations.FixedTimeEquals(computed, Digest);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(computed);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(password);
        }
    }

    private static bool ReadParameter(
        IReadOnlyDictionary<string, string> values,
        string name,
        out int result)
    {
        if (!values.TryGetValue(name, out var value))
        {
            result = 0;
            return false;
        }
        return int.TryParse(
            value,
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out result);
    }

    private static byte[] DecodeBase64(string value)
    {
        var padding = (4 - value.Length % 4) % 4;
        try
        {
            return Convert.FromBase64String(value + new string('=', padding));
        }
        catch (FormatException error)
        {
            throw new InvalidOperationException("invalid Base64 in Remote Core password hash", error);
        }
    }
}

internal static class PinRecovery
{
    public static async Task<string> RecoverAsync(Argon2PasswordHash hash, int workers)
    {
        const int MaximumConcurrentMemoryKib = 1_048_576;
        workers = Math.Min(
            workers,
            Math.Max(1, MaximumConcurrentMemoryKib / hash.MemorySize));
        string? found = null;
        using var stop = new CancellationTokenSource();
        try
        {
            await Parallel.ForEachAsync(
                Enumerable.Range(0, 10_000),
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = workers,
                    CancellationToken = stop.Token,
                },
                async (value, _) =>
                {
                    var candidate = value.ToString("D4", CultureInfo.InvariantCulture);
                    if (await hash.MatchesAsync(candidate) &&
                        Interlocked.CompareExchange(ref found, candidate, null) is null)
                    {
                        stop.Cancel();
                    }
                });
        }
        catch (OperationCanceledException) when (found is not null)
        {
        }

        return found ?? throw new InvalidOperationException(
            "the Remote Core hash did not match a four-digit PIN");
    }
}

internal static class WebConfigVerifier
{
    public static async Task VerifyAsync(string remote, string pin, byte[] certificate)
    {
        var expectedFingerprint = SHA256.HashData(certificate);
        CryptographicOperations.ZeroMemory(certificate);
        using var handler = new HttpClientHandler
        {
            CookieContainer = new CookieContainer(),
            ServerCertificateCustomValidationCallback = (_, actual, _, _) =>
                actual is not null && CryptographicOperations.FixedTimeEquals(
                    SHA256.HashData(actual.RawData), expectedFingerprint),
        };
        using var client = new HttpClient(handler)
        {
            BaseAddress = new Uri($"https://{remote}/"),
            Timeout = TimeSpan.FromSeconds(10),
        };

        using var login = await client.PostAsJsonAsync(
            "api/pub/login",
            new { username = "web-configurator", password = pin });
        if (login.StatusCode != HttpStatusCode.OK)
        {
            throw new InvalidOperationException(
                $"Web Config rejected the recovered PIN with HTTP {(int)login.StatusCode}");
        }
        using var loginBody = await JsonDocument.ParseAsync(await login.Content.ReadAsStreamAsync());
        if (!loginBody.RootElement.TryGetProperty("code", out var code) || code.GetString() != "OK")
        {
            throw new InvalidOperationException("Web Config rejected the recovered PIN");
        }

        using var system = await client.GetAsync("api/system");
        system.EnsureSuccessStatusCode();
        using var body = await JsonDocument.ParseAsync(await system.Content.ReadAsStreamAsync());
        var root = body.RootElement;
        if (root.GetProperty("model_number").GetString() != "ucr3" ||
            root.GetProperty("hw_revision").GetString() != "rev3")
        {
            throw new InvalidOperationException("authenticated target is not a Remote 3 rev3");
        }
    }
}

internal static class SelfTest
{
    public static async Task RunAsync()
    {
        var salt = Encoding.ASCII.GetBytes("0123456789abcdef");
        var password = Encoding.ASCII.GetBytes("0042");
        byte[] digest;
        using (var argon2 = new Argon2id(password)
        {
            Salt = salt,
            MemorySize = 1024,
            Iterations = 1,
            DegreeOfParallelism = 1,
        })
        {
            digest = await argon2.GetBytesAsync(32);
        }

        var encoded =
            $"$argon2id$v=19$m=1024,t=1,p=1${TrimPadding(salt)}${TrimPadding(digest)}";
        var parsed = Argon2PasswordHash.Parse(encoded);
        var recovered = await PinRecovery.RecoverAsync(parsed, 2);
        if (recovered != "0042")
        {
            throw new InvalidOperationException("self-test recovered the wrong PIN");
        }
    }

    private static string TrimPadding(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=');
}
