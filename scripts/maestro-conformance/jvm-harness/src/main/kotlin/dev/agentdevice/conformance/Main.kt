package dev.agentdevice.conformance

import java.nio.file.Files
import java.nio.file.Path

data class CorpusFlow(val id: String, val file: String)

/**
 * Conformance harness entry point.
 *
 * Usage:
 *   run --args="--corpus <corpusDir> --out <outDir>"
 *
 * Emits `<outDir>/layer1-parser.json` and `<outDir>/layer2-semantics.json`
 * containing only the generated content. `regenerate.mjs` verifies the resolved
 * jar SHA-256s and wraps each file with the upstream pin before checking it in.
 */
fun main(args: Array<String>) {
    val options = parseArgs(args)
    val corpusDir = options.getValue("corpus").let(Path::of)
    val outDir = options.getValue("out").let(Path::of)
    Files.createDirectories(outDir)

    val flows = readManifest(corpusDir.resolve("manifest.json"))

    val layer1 = emitLayer1(corpusDir, flows)
    // The parser resolves runScript/runFlow file references to absolute paths;
    // rewrite the corpus root to a stable token so fixtures are machine-independent.
    writeFixture(outDir.resolve("layer1-parser.json"), layer1, corpusDir.toAbsolutePath().toString())

    val layer2 = emitLayer2()
    writeFixture(outDir.resolve("layer2-semantics.json"), layer2, null)

    System.err.println("Emitted layer1 (${flows.size} flows) and layer2 to $outDir")
}

private fun parseArgs(args: Array<String>): Map<String, String> {
    val result = mutableMapOf<String, String>()
    var i = 0
    while (i < args.size) {
        val arg = args[i]
        require(arg.startsWith("--")) { "Unexpected argument: $arg" }
        require(i + 1 < args.size) { "Missing value for $arg" }
        result[arg.removePrefix("--")] = args[i + 1]
        i += 2
    }
    return result
}

private fun readManifest(manifestPath: Path): List<CorpusFlow> {
    val root = fixtureMapper.readTree(Files.readString(manifestPath))
    val flows = root.get("flows") ?: error("manifest.json missing 'flows'")
    return flows
        .filterNot { it.path("includeTargetOnly").asBoolean(false) }
        .map { CorpusFlow(it.get("id").asText(), it.get("file").asText()) }
}

private fun writeFixture(path: Path, node: com.fasterxml.jackson.databind.JsonNode, corpusRoot: String?) {
    var json = fixtureMapper.writeValueAsString(node)
    if (corpusRoot != null) json = json.replace(corpusRoot, "<corpus>")
    Files.writeString(path, json + "\n")
}
