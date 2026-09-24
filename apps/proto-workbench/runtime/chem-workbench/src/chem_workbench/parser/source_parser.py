"""Lexer and parser for the deliberately small ``chem 0.1`` source language."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import Enum, auto
from typing import Any

from chem_workbench.diagnostics import Diagnostic, Severity, SourceLocation
from chem_workbench.parser.model import Declaration, ParsedSource, ParseResult, SourceSpan

SUPPORTED_LANGUAGE_VERSION = "0.1"
MAX_LIST_DEPTH = 16
_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_IDENTIFIER_START = re.compile(r"[A-Za-z_]")
_IDENTIFIER_PART = re.compile(r"[A-Za-z0-9_.:-]")


class TokenKind(Enum):
    IDENTIFIER = auto()
    STRING = auto()
    NUMBER = auto()
    LEFT_BRACE = auto()
    RIGHT_BRACE = auto()
    LEFT_BRACKET = auto()
    RIGHT_BRACKET = auto()
    COMMA = auto()
    EOF = auto()


@dataclass(frozen=True, slots=True)
class Token:
    kind: TokenKind
    value: str
    line: int
    column: int
    end_line: int
    end_column: int


class Lexer:
    def __init__(self, text: str, source_name: str) -> None:
        self.text = text
        self.source_name = source_name
        self.index = 0
        self.line = 1
        self.column = 1
        self.diagnostics: list[Diagnostic] = []

    def tokenize(self) -> tuple[list[Token], list[Diagnostic]]:
        tokens: list[Token] = []
        while self.index < len(self.text):
            character = self.text[self.index]
            if character.isspace():
                self._advance()
                continue
            if character == "#" or self.text.startswith("//", self.index):
                self._skip_comment()
                continue
            if character in "{}[],":
                tokens.append(self._punctuation(character))
                continue
            if character == '"':
                token = self._string()
                if token is not None:
                    tokens.append(token)
                continue
            number_match = _NUMBER.match(self.text, self.index)
            if number_match is not None:
                tokens.append(self._number(number_match.group(0)))
                continue
            if _IDENTIFIER_START.fullmatch(character):
                tokens.append(self._identifier())
                continue
            location = self._location()
            self.diagnostics.append(
                Diagnostic(
                    Severity.ERROR,
                    "CHM1003",
                    f"Unexpected character {character!r}.",
                    location,
                    "Remove the character or put the value in a quoted string.",
                )
            )
            self._advance()
        tokens.append(Token(TokenKind.EOF, "", self.line, self.column, self.line, self.column))
        return tokens, self.diagnostics

    def _advance(self) -> str:
        character = self.text[self.index]
        self.index += 1
        if character == "\n":
            self.line += 1
            self.column = 1
        else:
            self.column += 1
        return character

    def _skip_comment(self) -> None:
        while self.index < len(self.text) and self.text[self.index] != "\n":
            self._advance()

    def _punctuation(self, character: str) -> Token:
        line, column = self.line, self.column
        self._advance()
        kind = {
            "{": TokenKind.LEFT_BRACE,
            "}": TokenKind.RIGHT_BRACE,
            "[": TokenKind.LEFT_BRACKET,
            "]": TokenKind.RIGHT_BRACKET,
            ",": TokenKind.COMMA,
        }[character]
        return Token(kind, character, line, column, self.line, self.column)

    def _identifier(self) -> Token:
        line, column, start = self.line, self.column, self.index
        while self.index < len(self.text) and _IDENTIFIER_PART.fullmatch(self.text[self.index]):
            self._advance()
        return Token(
            TokenKind.IDENTIFIER,
            self.text[start : self.index],
            line,
            column,
            self.line,
            self.column,
        )

    def _number(self, value: str) -> Token:
        line, column = self.line, self.column
        for _ in value:
            self._advance()
        return Token(TokenKind.NUMBER, value, line, column, self.line, self.column)

    def _string(self) -> Token | None:
        line, column, start = self.line, self.column, self.index
        self._advance()
        escaped = False
        while self.index < len(self.text):
            character = self._advance()
            if character == '"' and not escaped:
                raw = self.text[start : self.index]
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    self.diagnostics.append(
                        Diagnostic(
                            Severity.ERROR,
                            "CHM1007",
                            f"Invalid string literal: {error.msg}.",
                            SourceLocation(self.source_name, line, column),
                            "Use JSON-compatible escapes inside quoted strings.",
                        )
                    )
                    return None
                return Token(
                    TokenKind.STRING,
                    str(value),
                    line,
                    column,
                    self.line,
                    self.column,
                )
            if character == "\n" and not escaped:
                break
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
        self.diagnostics.append(
            Diagnostic(
                Severity.ERROR,
                "CHM1004",
                "Unterminated string literal.",
                SourceLocation(self.source_name, line, column),
                "Add a closing double quote.",
            )
        )
        return None

    def _location(self) -> SourceLocation:
        return SourceLocation(self.source_name, self.line, self.column)


class Parser:
    def __init__(self, tokens: list[Token], source_name: str) -> None:
        self.tokens = tokens
        self.source_name = source_name
        self.index = 0
        self.diagnostics: list[Diagnostic] = []

    def parse(self) -> ParsedSource | None:
        if not self._check_identifier("chem"):
            self._error(
                self._peek(),
                "CHM1001",
                "Source must start with a 'chem <version>' header.",
                "Add 'chem 0.1' as the first declaration.",
            )
            return None
        self._advance()
        version_token = self._peek()
        if version_token.kind not in (TokenKind.NUMBER, TokenKind.IDENTIFIER):
            self._error(
                version_token,
                "CHM1001",
                "The chem header is missing a language version.",
                "Use 'chem 0.1'.",
            )
            return None
        self._advance()
        version = version_token.value
        if version != SUPPORTED_LANGUAGE_VERSION:
            self._error(
                version_token,
                "CHM1002",
                f"Unsupported chem language version {version!r}.",
                f"Use the supported alpha version {SUPPORTED_LANGUAGE_VERSION!r}.",
            )

        declarations: list[Declaration] = []
        while self._peek().kind is not TokenKind.EOF:
            declaration = self._declaration()
            if declaration is not None:
                declarations.append(declaration)
            else:
                self._synchronize_declaration()
        return ParsedSource(version, tuple(declarations))

    def _declaration(self) -> Declaration | None:
        kind_token = self._consume(
            TokenKind.IDENTIFIER,
            "CHM1003",
            "Expected a declaration kind.",
            "Use a declaration such as 'molecule water { ... }'.",
        )
        if kind_token is None:
            return None
        identifier_token = self._consume(
            TokenKind.IDENTIFIER,
            "CHM1003",
            f"Declaration {kind_token.value!r} is missing an identifier.",
            "Add a stable identifier before the opening brace.",
        )
        if identifier_token is None:
            return None
        if (
            self._consume(
                TokenKind.LEFT_BRACE,
                "CHM1003",
                f"Declaration {identifier_token.value!r} is missing an opening brace.",
                "Add '{' after the declaration identifier.",
            )
            is None
        ):
            return None

        fields: dict[str, Any] = {}
        field_spans: dict[str, SourceSpan] = {}
        while self._peek().kind not in (TokenKind.RIGHT_BRACE, TokenKind.EOF):
            field_token = self._consume(
                TokenKind.IDENTIFIER,
                "CHM1003",
                "Expected a field name inside the declaration.",
                "Use a field name followed by a value.",
            )
            if field_token is None:
                self._advance()
                continue
            parsed_fields = self._field(field_token)
            for name, value, span in parsed_fields:
                if name in fields:
                    self._error(
                        field_token,
                        "CHM1006",
                        f"Field {name!r} is declared more than once.",
                        "Keep exactly one value for each field.",
                    )
                    continue
                fields[name] = value
                field_spans[name] = span

        end_token = self._peek()
        if end_token.kind is TokenKind.EOF:
            self._error(
                end_token,
                "CHM1005",
                f"Declaration {identifier_token.value!r} is missing a closing brace.",
                "Add '}' after its final field.",
            )
        else:
            end_token = self._advance()
        return Declaration(
            kind_token.value,
            identifier_token.value,
            fields,
            field_spans,
            SourceSpan(
                self.source_name,
                kind_token.line,
                kind_token.column,
                end_token.end_line,
                end_token.end_column,
            ),
        )

    def _field(self, token: Token) -> list[tuple[str, Any, SourceSpan]]:
        span = SourceSpan(
            self.source_name,
            token.line,
            token.column,
            token.end_line,
            token.end_column,
        )
        if token.value == "structure":
            format_token = self._consume_value_token(
                "CHM1003", "A structure field requires a format.", "Add a format such as smiles."
            )
            value_token = self._consume_value_token(
                "CHM1003",
                "A structure field requires a quoted value or path.",
                "Add the representation after the format.",
            )
            if format_token is None or value_token is None:
                return []
            return [
                (
                    "structure",
                    {"format": format_token.value.lower(), "value": value_token.value},
                    span,
                )
            ]
        if token.value == "finite":
            charge_label = self._consume_identifier_value("charge")
            charge_token = self._consume_value_token(
                "CHM1003", "A finite state requires charge.", "Add 'charge <integer>'."
            )
            multiplicity_label = self._consume_identifier_value("multiplicity")
            multiplicity_token = self._consume_value_token(
                "CHM1003",
                "A finite state requires multiplicity.",
                "Add 'multiplicity <positive integer>'.",
            )
            if None in (charge_label, charge_token, multiplicity_label, multiplicity_token):
                return []
            assert charge_token is not None
            assert multiplicity_token is not None
            return [
                ("model", "finite", span),
                ("charge", self._number_value(charge_token), span),
                ("multiplicity", self._number_value(multiplicity_token), span),
            ]
        value = self._value()
        if value is _RECOVERED_MISSING:
            return []
        if value is _MISSING:
            self._error(
                self._peek(),
                "CHM1003",
                f"Field {token.value!r} is missing a value.",
                "Add a string, number, identifier, or list after the field name.",
            )
            return []
        return [(token.value, value, span)]

    def _value(self, depth: int = 0) -> Any:
        token = self._peek()
        if token.kind is TokenKind.LEFT_BRACKET:
            if depth >= MAX_LIST_DEPTH:
                self._error(
                    token,
                    "CHM1009",
                    f"List nesting exceeds the alpha limit of {MAX_LIST_DEPTH}.",
                    "Flatten the declarative value; nested unbounded data is not supported.",
                )
                self._skip_balanced_list()
                return _RECOVERED_MISSING
            return self._list_value(depth + 1)
        if token.kind is TokenKind.STRING:
            self._advance()
            return token.value
        if token.kind is TokenKind.NUMBER:
            self._advance()
            return self._number_value(token)
        if token.kind is TokenKind.IDENTIFIER:
            self._advance()
            if token.value == "true":
                return True
            if token.value == "false":
                return False
            return token.value
        return _MISSING

    def _list_value(self, depth: int) -> list[Any]:
        self._advance()
        values: list[Any] = []
        while self._peek().kind not in (TokenKind.RIGHT_BRACKET, TokenKind.EOF):
            value = self._value(depth)
            if value is _RECOVERED_MISSING:
                continue
            if value is _MISSING:
                self._error(
                    self._peek(),
                    "CHM1003",
                    "Expected a value in the list.",
                    "Remove the token or add a valid list value.",
                )
                self._advance()
            else:
                values.append(value)
            if self._peek().kind is TokenKind.COMMA:
                self._advance()
        if self._peek().kind is TokenKind.RIGHT_BRACKET:
            self._advance()
        else:
            self._error(
                self._peek(),
                "CHM1005",
                "List is missing a closing bracket.",
                "Add ']'.",
            )
        return values

    def _skip_balanced_list(self) -> None:
        nesting = 0
        while self._peek().kind is not TokenKind.EOF:
            token = self._advance()
            if token.kind is TokenKind.LEFT_BRACKET:
                nesting += 1
            elif token.kind is TokenKind.RIGHT_BRACKET:
                nesting -= 1
                if nesting == 0:
                    return

    @staticmethod
    def _number_value(token: Token) -> int | float:
        if any(character in token.value for character in ".eE"):
            return float(token.value)
        return int(token.value)

    def _consume_identifier_value(self, expected: str) -> Token | None:
        token = self._peek()
        if token.kind is TokenKind.IDENTIFIER and token.value == expected:
            return self._advance()
        self._error(
            token,
            "CHM1003",
            f"Expected {expected!r} in finite electronic state.",
            "Use 'finite charge <integer> multiplicity <integer>'.",
        )
        return None

    def _consume_value_token(self, code: str, message: str, suggestion: str) -> Token | None:
        token = self._peek()
        if token.kind in (TokenKind.IDENTIFIER, TokenKind.STRING, TokenKind.NUMBER):
            return self._advance()
        self._error(token, code, message, suggestion)
        return None

    def _consume(
        self,
        kind: TokenKind,
        code: str,
        message: str,
        suggestion: str,
    ) -> Token | None:
        if self._peek().kind is kind:
            return self._advance()
        self._error(self._peek(), code, message, suggestion)
        return None

    def _check_identifier(self, value: str) -> bool:
        token = self._peek()
        return token.kind is TokenKind.IDENTIFIER and token.value == value

    def _synchronize_declaration(self) -> None:
        while self._peek().kind is not TokenKind.EOF:
            if self._peek().kind is TokenKind.RIGHT_BRACE:
                self._advance()
                return
            self._advance()

    def _error(self, token: Token, code: str, message: str, suggestion: str) -> None:
        self.diagnostics.append(
            Diagnostic(
                Severity.ERROR,
                code,
                message,
                SourceLocation(self.source_name, token.line, token.column),
                suggestion,
            )
        )

    def _peek(self) -> Token:
        return self.tokens[self.index]

    def _advance(self) -> Token:
        token = self.tokens[self.index]
        if token.kind is not TokenKind.EOF:
            self.index += 1
        return token


_MISSING = object()
_RECOVERED_MISSING = object()


def parse_source(text: str, source_name: str = "<memory>") -> ParseResult:
    lexer = Lexer(text, source_name)
    tokens, lexer_diagnostics = lexer.tokenize()
    parser = Parser(tokens, source_name)
    parsed_source = parser.parse()
    return ParseResult(parsed_source, tuple([*lexer_diagnostics, *parser.diagnostics]))
