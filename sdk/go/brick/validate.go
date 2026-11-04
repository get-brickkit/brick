package brick

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"
	"unicode/utf16"
)

// Issue is one validation problem, as Brick's TypeScript actions report it.
type Issue struct {
	Path    string          `json:"path"`
	Message string          `json:"message"`
	Value   json.RawMessage `json:"value,omitempty"`
}

// missing stands for a required property that is absent (JavaScript's undefined).
type missing struct{}

// validate checks value against an inlined JSON Schema and reports the
// problems with TypeBox's messages, paths and order, so a Go action rejects
// bad input exactly as a TypeScript action does. It covers type, required,
// properties, additionalProperties, enum, const, anyOf/oneOf, string length
// and pattern, number bounds and multipleOf, and array items and length.
func validate(schema *object, value any) []Issue {
	var issues []Issue
	visit(schema, "", value, &issues)
	return issues
}

func issue(issues *[]Issue, path, message string, value any) {
	it := Issue{Path: path, Message: message}
	if _, ok := value.(missing); !ok {
		var b bytes.Buffer
		writeJSON(&b, value)
		it.Value = b.Bytes()
	}
	*issues = append(*issues, it)
}

func visit(s *object, path string, value any, issues *[]Issue) {
	if s == nil {
		return
	}
	if enum, ok := s.get("enum"); ok {
		for _, candidate := range enum.([]any) {
			if equalJSON(candidate, value) {
				return
			}
		}
		issue(issues, path, "Expected union value", value)
		return
	}
	if c, ok := s.get("const"); ok {
		if !equalJSON(c, value) {
			msg := fmt.Sprintf("Expected %s", constText(c))
			issue(issues, path, msg, value)
		}
		return
	}
	for _, key := range []string{"anyOf", "oneOf"} {
		if variants, ok := s.get(key); ok {
			for _, v := range variants.([]any) {
				var inner []Issue
				visit(asObject(v), path, value, &inner)
				if len(inner) == 0 {
					return
				}
			}
			issue(issues, path, "Expected union value", value)
			return
		}
	}
	typ, _ := s.get("type")
	if types, ok := typ.([]any); ok {
		typ = nil
		for _, t := range types {
			if hasType(t.(string), value) {
				typ = t
				break
			}
		}
		if typ == nil {
			issue(issues, path, "Expected union value", value)
			return
		}
	}
	switch typ {
	case "object":
		visitObject(s, path, value, issues)
	case "array":
		arr, ok := value.([]any)
		if !ok {
			issue(issues, path, "Expected array", value)
			return
		}
		if n, ok := num(s, "minItems"); ok && float64(len(arr)) < n {
			issue(issues, path, "Expected array length to be greater or equal to "+jsNumber(n), value)
		}
		if n, ok := num(s, "maxItems"); ok && float64(len(arr)) > n {
			issue(issues, path, "Expected array length to be less or equal to "+jsNumber(n), value)
		}
		items := asObject(s.vals["items"])
		for i, item := range arr {
			visit(items, fmt.Sprintf("%s/%d", path, i), item, issues)
		}
	case "string":
		str, ok := value.(string)
		if !ok {
			issue(issues, path, "Expected string", value)
			return
		}
		length := float64(len(utf16.Encode([]rune(str))))
		if n, ok := num(s, "minLength"); ok && length < n {
			issue(issues, path, "Expected string length greater or equal to "+jsNumber(n), value)
		}
		if n, ok := num(s, "maxLength"); ok && length > n {
			issue(issues, path, "Expected string length less or equal to "+jsNumber(n), value)
		}
		if p, ok := s.vals["pattern"].(string); ok && !compiled(p).MatchString(str) {
			issue(issues, path, fmt.Sprintf("Expected string to match '%s'", p), value)
		}
	case "integer", "number":
		n, ok := value.(json.Number)
		f, err := n.Float64()
		if !ok || err != nil || (typ == "integer" && f != math.Trunc(f)) {
			issue(issues, path, "Expected "+typ.(string), value)
			return
		}
		kind := typ.(string)
		if m, ok := num(s, "exclusiveMaximum"); ok && !(f < m) {
			issue(issues, path, fmt.Sprintf("Expected %s to be less than %s", kind, jsNumber(m)), value)
		}
		if m, ok := num(s, "exclusiveMinimum"); ok && !(f > m) {
			issue(issues, path, fmt.Sprintf("Expected %s to be greater than %s", kind, jsNumber(m)), value)
		}
		if m, ok := num(s, "maximum"); ok && !(f <= m) {
			issue(issues, path, fmt.Sprintf("Expected %s to be less or equal to %s", kind, jsNumber(m)), value)
		}
		if m, ok := num(s, "minimum"); ok && !(f >= m) {
			issue(issues, path, fmt.Sprintf("Expected %s to be greater or equal to %s", kind, jsNumber(m)), value)
		}
		if m, ok := num(s, "multipleOf"); ok && math.Mod(f, m) != 0 {
			issue(issues, path, fmt.Sprintf("Expected %s to be a multiple of %s", kind, jsNumber(m)), value)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			issue(issues, path, "Expected boolean", value)
		}
	case "null":
		if value != nil {
			issue(issues, path, "Expected null", value)
		}
	}
}

func visitObject(s *object, path string, value any, issues *[]Issue) {
	obj, ok := value.(*object)
	if !ok {
		issue(issues, path, "Expected object", value)
		return
	}
	props := asObject(s.vals["properties"])
	if props == nil {
		props = newObject()
	}
	required := map[string]bool{}
	if req, ok := s.vals["required"].([]any); ok {
		for _, r := range req {
			key := r.(string)
			required[key] = true
			if _, present := obj.vals[key]; !present {
				issue(issues, path+"/"+escapeKey(key), "Expected required property", missing{})
			}
		}
	}
	switch extra := s.vals["additionalProperties"].(type) {
	case bool:
		if !extra {
			for _, key := range obj.keys {
				if _, known := props.vals[key]; !known {
					issue(issues, path+"/"+escapeKey(key), "Unexpected property", obj.vals[key])
				}
			}
		}
	case *object:
		for _, key := range obj.keys {
			if _, known := props.vals[key]; !known {
				visit(extra, path+"/"+escapeKey(key), obj.vals[key], issues)
			}
		}
	}
	for _, key := range props.keys {
		v, present := obj.vals[key]
		if required[key] {
			if !present {
				v = missing{}
			}
			visit(asObject(props.vals[key]), path+"/"+escapeKey(key), v, issues)
		} else if present {
			visit(asObject(props.vals[key]), path+"/"+escapeKey(key), v, issues)
		}
	}
}

func hasType(t string, value any) bool {
	switch v := value.(type) {
	case nil:
		return t == "null"
	case bool:
		return t == "boolean"
	case string:
		return t == "string"
	case []any:
		return t == "array"
	case *object:
		return t == "object"
	case json.Number:
		f, _ := v.Float64()
		return t == "number" || (t == "integer" && f == math.Trunc(f))
	}
	return false
}

func asObject(v any) *object {
	o, _ := v.(*object)
	return o
}

func num(s *object, key string) (float64, bool) {
	n, ok := s.vals[key].(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

func constText(c any) string {
	if s, ok := c.(string); ok {
		return "'" + s + "'"
	}
	var b bytes.Buffer
	writeJSON(&b, c)
	return b.String()
}

func equalJSON(a, b any) bool {
	var x, y bytes.Buffer
	writeJSON(&x, a)
	writeJSON(&y, b)
	return x.String() == y.String()
}

func escapeKey(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}

var patterns sync.Map

func compiled(p string) *regexp.Regexp {
	if re, ok := patterns.Load(p); ok {
		return re.(*regexp.Regexp)
	}
	re := regexp.MustCompile(p)
	patterns.Store(p, re)
	return re
}
