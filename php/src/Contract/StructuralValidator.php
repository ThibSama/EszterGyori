<?php

declare(strict_types=1);

namespace Eszter\Contract;

use Opis\JsonSchema\Errors\ValidationError;
use Opis\JsonSchema\Helper;
use Opis\JsonSchema\Validator;

/**
 * The structural half of contract validation: the committed
 * `contracts/generated/*.schema.json` documents, run as JSON Schema 2020-12.
 *
 * Every artifact carries `x-eszter-warning` saying that passing it is necessary
 * but *not* sufficient. That is load-bearing — see {@see SemanticRuleValidator}
 * for the other half, and {@see ContentValidator} for the composition.
 *
 * `format` assertion is switched off on purpose. The reference implementation
 * emits `format` as an annotation only (`docs/contract-freeze.md`: "JSON Schema
 * `format` is annotation-only"), and the real restrictions behind those
 * annotations — `mailto:` addresses, Instagram hosts, media protocols — are
 * declared semantic rules. Letting the structural layer also assert `format`
 * would put one constraint in two places with two different definitions.
 */
final class StructuralValidator
{
    private readonly Validator $validator;

    public function __construct(private readonly ContractArtifacts $artifacts)
    {
        // maxErrors high enough to report a whole document, stopAtFirstError off:
        // the corpus compares issue *sets*, so truncating them would hide drift.
        $this->validator = new Validator(null, 200, false);
        $this->validator->parser()->setOption('allowFormats', false);
    }

    /**
     * @param string $schemaFile Artifact name, e.g. `site-content.input.schema.json`.
     * @param string $prefix     JSON Pointer prefix prepended to every issue path,
     *                           so a nested document reports envelope-relative paths.
     * @return list<ValidationIssue>
     */
    public function validate(mixed $document, string $schemaFile, string $prefix = ''): array
    {
        // Decoded to objects, not associative arrays: see
        // {@see ContractArtifacts::schemaDocument()} for why the difference is
        // load-bearing for an empty `{}` subschema.
        $schema = $this->artifacts->schemaDocument($schemaFile);

        /** @var mixed $data */
        $data = Helper::toJSON($document);

        $result = $this->validator->validate($data, $schema);
        $error = $result->error();

        if ($error === null) {
            return [];
        }

        $issues = [];
        $this->collect($error, $prefix, $issues, $schemaFile);

        return $issues;
    }

    /**
     * Walks to the deepest error in each branch: opis reports a parent keyword
     * (`properties`, `anyOf`) wrapping the leaf that actually failed, and the leaf
     * is the one whose pointer is meaningful.
     *
     * One opis quirk is filtered out here. When `properties` fails, the set of
     * evaluated property names is left incomplete, so the sibling
     * `additionalProperties` check then rejects *every* key at that level and
     * reports a second error on the container. That error is an artefact of the
     * first one, and reporting it would blame `/hero` for a bad `/hero/description`.
     * It is dropped whenever a real sibling error exists at the same path.
     *
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function collect(
        ValidationError $error,
        string $prefix,
        array &$issues,
        string $schemaFile,
    ): void {
        $subErrors = $this->withoutDerivedContainerErrors($error->subErrors());

        if ($subErrors !== []) {
            foreach ($subErrors as $subError) {
                $this->collect($subError, $prefix, $issues, $schemaFile);
            }

            return;
        }

        /** @var list<string|int> $path */
        $path = $error->data()->fullPath();

        $issues[] = new ValidationIssue(
            $prefix . JsonPointer::compile($path),
            \sprintf('%s (%s: %s)', $error->message(), $schemaFile, $error->keyword()),
        );
    }

    /**
     * opis declares `subErrors()` as a bare `array`, so the element type is
     * established here rather than assumed.
     *
     * @param array<mixed> $errors
     * @return list<ValidationError>
     */
    private function withoutDerivedContainerErrors(array $errors): array
    {
        $all = [];
        $substantive = [];

        foreach ($errors as $error) {
            if (!$error instanceof ValidationError) {
                continue;
            }

            $all[] = $error;

            if ($error->keyword() !== 'additionalProperties') {
                $substantive[] = $error;
            }
        }

        return $substantive === [] ? $all : $substantive;
    }
}
