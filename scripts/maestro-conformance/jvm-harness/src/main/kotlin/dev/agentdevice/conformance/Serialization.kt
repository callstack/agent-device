package dev.agentdevice.conformance

import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.json.JsonMapper
import com.fasterxml.jackson.module.kotlin.kotlinModule

/**
 * A single JSON mapper used for every fixture we emit. Keys are sorted so the
 * generated fixtures are byte-stable across regenerations (the deterministic
 * verifier and `regenerate.mjs` both rely on stable ordering).
 */
val fixtureMapper: JsonMapper = JsonMapper.builder()
    .addModule(kotlinModule())
    .configure(SerializationFeature.FAIL_ON_EMPTY_BEANS, false)
    .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true)
    .enable(SerializationFeature.INDENT_OUTPUT)
    .build()

/**
 * The single sub-command carried by a Maestro `MaestroCommand` wrapper. The
 * wrapper exposes one non-null `getXxxCommand()` / `getTapOnElement()` getter;
 * we return the first payload whose class is an `maestro.orchestra.*Command`.
 * This is a faithful projection: we do not rename or reshape any field, we only
 * locate the active variant. The field-level mapping to our IR lives in the
 * checked-in Node normalizer, applied to this generated capture.
 */
fun activeCommand(command: Any): Any? =
    command.javaClass.methods
        .asSequence()
        .filter { it.name.startsWith("get") && it.parameterCount == 0 && it.name != "getClass" }
        .mapNotNull { m -> runCatching { m.invoke(command) }.getOrNull() }
        .firstOrNull {
            it.javaClass.name.startsWith("maestro.orchestra.") &&
                it.javaClass.simpleName.endsWith("Command")
        }
