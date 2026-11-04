package brick

import (
	"encoding/json"
	"maps"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/danielgtaylor/huma/v2"
)

// schema is the inlined JSON Schema of t, as Huma describes it, with
// properties in field order (Huma's JSON sorts them).
func (s *Service) schema(t reflect.Type, hint string) *object {
	return s.convert(s.registry.Schema(t, false, hint), t, map[reflect.Type]bool{})
}

func (s *Service) convert(hs *huma.Schema, t reflect.Type, active map[reflect.Type]bool) *object {
	if hs == nil {
		return newObject()
	}
	if hs.Ref != "" {
		hs = s.registry.SchemaFromRef(hs.Ref)
	}
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	data, _ := json.Marshal(hs)
	node, _ := decodeOrdered(data)
	o, ok := node.(*object)
	if !ok {
		return newObject()
	}
	// shortcut: a recursive type is cut off at its second level; inline schemas cannot express it.
	if t != nil && t.Kind() == reflect.Struct && active[t] {
		return newObject()
	}
	if t != nil && t.Kind() == reflect.Struct {
		active[t] = true
		defer delete(active, t)
	}
	if hs.Items != nil {
		var elem reflect.Type
		if t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
			elem = t.Elem()
		}
		o.set("items", s.convert(hs.Items, elem, active))
	}
	if extra, ok := hs.AdditionalProperties.(*huma.Schema); ok {
		var elem reflect.Type
		if t != nil && t.Kind() == reflect.Map {
			elem = t.Elem()
		}
		o.set("additionalProperties", s.convert(extra, elem, active))
	}
	if len(hs.Properties) > 0 {
		props := newObject()
		if t != nil && t.Kind() == reflect.Struct {
			for _, f := range jsonFields(t) {
				if ps, ok := hs.Properties[f.name]; ok {
					props.set(f.name, s.convert(ps, f.typ, active))
				}
			}
		}
		for _, name := range slices.Sorted(maps.Keys(hs.Properties)) {
			if _, done := props.vals[name]; !done {
				props.set(name, s.convert(hs.Properties[name], nil, active))
			}
		}
		o.set("properties", props)
	}
	return o
}

type jsonField struct {
	name string
	typ  reflect.Type
}

// jsonFields lists a struct's JSON fields in Huma's order: its own, then embedded ones.
func jsonFields(t reflect.Type) []jsonField {
	var fields, embedded []jsonField
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "-" {
			continue
		}
		if f.Anonymous && name == "" {
			et := f.Type
			for et.Kind() == reflect.Pointer {
				et = et.Elem()
			}
			if et.Kind() == reflect.Struct {
				embedded = append(embedded, jsonFields(et)...)
			}
			continue
		}
		if name == "" {
			name = f.Name
		}
		fields = append(fields, jsonField{name, f.Type})
	}
	return append(fields, embedded...)
}

var (
	kebabLower = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	kebabUpper = regexp.MustCompile(`([A-Z]+)([A-Z][a-z])`)
)

// kebab is Brick's URL segment for a name: chargeCard → charge-card.
func kebab(name string) string {
	s := kebabLower.ReplaceAllString(name, "$1-$2")
	return strings.ToLower(kebabUpper.ReplaceAllString(s, "$1-$2"))
}

func pascal(name string) string {
	var b strings.Builder
	up := true
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			up = true
			continue
		}
		if up {
			r = unicode.ToUpper(r)
			up = false
		}
		b.WriteRune(r)
	}
	return b.String()
}
