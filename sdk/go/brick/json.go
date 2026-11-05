package brick

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
)

// object is a JSON object that keeps its key order, so schemas list
// properties as declared and error values print as the client sent them.
type object struct {
	keys []string
	vals map[string]any
}

func newObject() *object { return &object{vals: map[string]any{}} }

func (o *object) set(key string, value any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
}

func (o *object) get(key string) (any, bool) {
	v, ok := o.vals[key]
	return v, ok
}

// MarshalJSON writes the keys in order.
func (o *object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	writeJSON(&b, o)
	return b.Bytes(), nil
}

// decodeOrdered parses JSON into nil, bool, json.Number, string, []any and *object.
func decodeOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("invalid character after top-level value")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch delim {
	case '{':
		o := newObject()
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return nil, err
			}
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			o.set(key.(string), v)
		}
		_, err = dec.Token()
		return o, err
	case '[':
		arr := []any{}
		for dec.More() {
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err = dec.Token()
		return arr, err
	}
	return nil, errors.New("unexpected delimiter")
}

// marshal is json.Marshal without HTML escaping or a trailing newline, as
// JavaScript's JSON.stringify writes it.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func writeJSON(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case json.Number:
		// An integer literal stays as sent: through float64 it would lose digits past 2^53.
		if _, err := strconv.ParseInt(t.String(), 10, 64); err == nil {
			b.WriteString(t.String())
			return
		}
		f, err := t.Float64()
		if err != nil {
			b.WriteString(t.String())
		} else {
			b.WriteString(jsNumber(f))
		}
	case string:
		s, _ := marshal(t)
		b.Write(s)
	case []any:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, item)
		}
		b.WriteByte(']')
	case *object:
		b.WriteByte('{')
		for i, key := range t.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			k, _ := marshal(key)
			b.Write(k)
			b.WriteByte(':')
			writeJSON(b, t.vals[key])
		}
		b.WriteByte('}')
	default:
		s, _ := marshal(t)
		b.Write(s)
	}
}

// jsNumber formats a number as JavaScript prints it, for the common cases.
func jsNumber(f float64) string {
	if abs := math.Abs(f); abs != 0 && (abs < 1e-6 || abs >= 1e21) {
		// JavaScript's exponent form has no leading zero: 1e-7, 1e+21.
		s := strconv.FormatFloat(f, 'e', -1, 64)
		return strings.Replace(strings.Replace(s, "e-0", "e-", 1), "e+0", "e+", 1)
	}
	// Beyond 2^53 JavaScript prints the shortest digits padded with zeros, as 'f' does.
	if f == math.Trunc(f) && math.Abs(f) <= 1<<53 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
