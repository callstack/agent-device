plugins {
    kotlin("jvm") version "2.2.20"
    application
}

// Pins for the upstream Maestro artifacts the oracle is generated against. These
// MUST match `pinned-upstream.json` in the parent directory; `regenerate.mjs`
// verifies the resolved jar SHA-256s against that file before trusting output.
val maestroVersion = "2.5.1"

repositories {
    mavenCentral()
}

dependencies {
    // Layer 1 parser + Layer 2 model defaults (YamlCommandReader, command models).
    implementation("dev.mobile:maestro-orchestra:$maestroVersion")
    implementation("dev.mobile:maestro-orchestra-models:$maestroVersion")
    // Layer 2 constants (Maestro.SCREENSHOT_DIFF_THRESHOLD / ANIMATION_TIMEOUT_MS,
    // Orchestra.MAX_RETRIES_ALLOWED). Read as bytecode ConstantValue attributes via
    // ASM — the harness never initializes these driver-bound classes.
    implementation("dev.mobile:maestro-client:$maestroVersion")
    implementation("org.ow2.asm:asm:9.7")
    // Jackson (already transitive via maestro-orchestra) for JSON emission.
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")
}

application {
    mainClass.set("dev.agentdevice.conformance.MainKt")
}

kotlin {
    jvmToolchain(17)
}

// Prints the resolved upstream (dev.mobile) jars so `regenerate.mjs` can verify
// the SHA-256 of the exact bytes the harness compiled and ran against, against
// `pinned-upstream.json`. This is the regeneration-time artifact-integrity gate.
tasks.register("printUpstreamJars") {
    val artifacts = configurations.named("runtimeClasspath")
    doLast {
        artifacts.get().resolvedConfiguration.resolvedArtifacts
            .filter { it.moduleVersion.id.group == "dev.mobile" }
            .forEach { a ->
                println("UPSTREAM_JAR ${a.moduleVersion.id.name}:${a.moduleVersion.id.version} ${a.file}")
            }
    }
}
