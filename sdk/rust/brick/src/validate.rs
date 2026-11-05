use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Arc, sync::Mutex, sync::OnceLock};

/// One validation problem, as Brick's TypeScript actions report it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<Value>,
}

pub(crate) fn validation_error(action: &str, issues: Vec<Issue>) -> Error {
    Error {
        name: "ValidationError".into(),
        errors: Some(issues),
        ..Error::new(
            "VALIDATION_FAILED",
            400,
            &format!("Validation failed for action '{action}' input"),
        )
    }
}

/// Check `value` and report the problems with TypeBox's messages, paths and
/// order, so a Rust action rejects bad input exactly as a TypeScript action
/// does. The walk covers type, required, properties, additionalProperties,
/// enum, const, anyOf/oneOf, string length and pattern, number bounds and
/// multipleOf, and array items and length; `jsonschema` catches the rest.
pub(crate) fn validate(
    schema: &Value,
    value: &Value,
    validator: &jsonschema::Validator,
) -> Vec<Issue> {
    let mut issues = Vec::new();
    visit(schema, "", Some(value), &mut issues);
    if issues.is_empty() && !validator.is_valid(value) {
        for e in validator.iter_errors(value) {
            issues.push(Issue {
                path: e.instance_path().to_string(),
                message: e.to_string(),
                value: Some(e.instance().clone().into_owned()),
            });
        }
    }
    issues
}

fn push(issues: &mut Vec<Issue>, path: &str, message: String, value: Option<&Value>) {
    issues.push(Issue {
        path: path.into(),
        message,
        value: value.cloned(),
    });
}

/// `schema` without minLength and maxLength (numbers, so a property of that name stays).
pub(crate) fn without_lengths(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, v)| {
                    !(matches!(k.as_str(), "minLength" | "maxLength") && v.is_number())
                })
                .map(|(k, v)| (k.clone(), without_lengths(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_lengths).collect()),
        other => other.clone(),
    }
}

/// `value` with every whole float that fits exactly (up to 2^53) as an integer.
pub(crate) fn whole_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0 => {
                Value::from(f as i64)
            }
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(whole_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, whole_numbers(item)))
                .collect(),
        ),
        other => other,
    }
}

/// A number as JavaScript prints it, for the common cases.
pub(crate) fn js_number(f: f64) -> String {
    if f != 0.0 && (f.abs() < 1e-6 || f.abs() >= 1e21) {
        // JavaScript's exponent form: 1e-7, 1e+21.
        let s = format!("{f:e}");
        if s.contains("e-") {
            s
        } else {
            s.replace('e', "e+")
        }
    } else if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0 {
        format!("{}", f as i64)
    } else {
        // Beyond 2^53 too: the shortest digits, padded with zeros.
        format!("{f}")
    }
}

fn escape_key(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn utf16_len(s: &str) -> f64 {
    s.encode_utf16().count() as f64
}

fn has_type(t: &str, value: &Value) -> bool {
    match value {
        Value::Null => t == "null",
        Value::Bool(_) => t == "boolean",
        Value::String(_) => t == "string",
        Value::Array(_) => t == "array",
        Value::Object(_) => t == "object",
        Value::Number(n) => {
            t == "number" || (t == "integer" && n.as_f64().is_some_and(|f| f.fract() == 0.0))
        }
    }
}

fn visit(schema: &Value, path: &str, value: Option<&Value>, issues: &mut Vec<Issue>) {
    let Some(s) = schema.as_object() else { return };
    if let Some(Value::Array(options)) = s.get("enum") {
        if !value.is_some_and(|v| options.contains(v)) {
            push(issues, path, "Expected union value".into(), value);
        }
        return;
    }
    if let Some(c) = s.get("const") {
        if value != Some(c) {
            let text = match c {
                Value::String(s) => format!("'{s}'"),
                other => other.to_string(),
            };
            push(issues, path, format!("Expected {text}"), value);
        }
        return;
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(variants)) = s.get(key) {
            let ok = variants.iter().any(|variant| {
                let mut inner = Vec::new();
                visit(variant, path, value, &mut inner);
                inner.is_empty()
            });
            if !ok {
                push(issues, path, "Expected union value".into(), value);
            }
            return;
        }
    }
    let typ = match s.get("type") {
        Some(Value::String(t)) => Some(t.as_str()),
        Some(Value::Array(types)) => {
            let found = types
                .iter()
                .filter_map(Value::as_str)
                .find(|t| value.is_some_and(|v| has_type(t, v)));
            if found.is_none() {
                push(issues, path, "Expected union value".into(), value);
                return;
            }
            found
        }
        _ => None,
    };
    let num = |key: &str| s.get(key).and_then(Value::as_f64);
    match typ {
        Some("object") => visit_object(s, path, value, issues),
        Some("array") => {
            let Some(Value::Array(items)) = value else {
                return push(issues, path, "Expected array".into(), value);
            };
            let len = items.len() as f64;
            if let Some(n) = num("minItems").filter(|n| len < *n) {
                push(
                    issues,
                    path,
                    format!(
                        "Expected array length to be greater or equal to {}",
                        js_number(n)
                    ),
                    value,
                );
            }
            if let Some(n) = num("maxItems").filter(|n| len > *n) {
                push(
                    issues,
                    path,
                    format!(
                        "Expected array length to be less or equal to {}",
                        js_number(n)
                    ),
                    value,
                );
            }
            if let Some(item_schema) = s.get("items") {
                for (i, item) in items.iter().enumerate() {
                    visit(item_schema, &format!("{path}/{i}"), Some(item), issues);
                }
            }
        }
        Some("string") => {
            let Some(Value::String(text)) = value else {
                return push(issues, path, "Expected string".into(), value);
            };
            let len = utf16_len(text);
            if let Some(n) = num("minLength").filter(|n| len < *n) {
                push(
                    issues,
                    path,
                    format!(
                        "Expected string length greater or equal to {}",
                        js_number(n)
                    ),
                    value,
                );
            }
            if let Some(n) = num("maxLength").filter(|n| len > *n) {
                push(
                    issues,
                    path,
                    format!("Expected string length less or equal to {}", js_number(n)),
                    value,
                );
            }
            if let Some(Value::String(p)) = s.get("pattern")
                && !pattern_matches(p, text)
            {
                push(
                    issues,
                    path,
                    format!("Expected string to match '{p}'"),
                    value,
                );
            }
        }
        Some(kind @ ("integer" | "number")) => {
            let f = match value {
                Some(Value::Number(n)) => {
                    n.as_f64().filter(|f| kind == "number" || f.fract() == 0.0)
                }
                _ => None,
            };
            let Some(f) = f else {
                return push(issues, path, format!("Expected {kind}"), value);
            };
            if let Some(m) = num("exclusiveMaximum").filter(|m| f >= *m) {
                push(
                    issues,
                    path,
                    format!("Expected {kind} to be less than {}", js_number(m)),
                    value,
                );
            }
            if let Some(m) = num("exclusiveMinimum").filter(|m| f <= *m) {
                push(
                    issues,
                    path,
                    format!("Expected {kind} to be greater than {}", js_number(m)),
                    value,
                );
            }
            if let Some(m) = num("maximum").filter(|m| f > *m) {
                push(
                    issues,
                    path,
                    format!("Expected {kind} to be less or equal to {}", js_number(m)),
                    value,
                );
            }
            if let Some(m) = num("minimum").filter(|m| f < *m) {
                push(
                    issues,
                    path,
                    format!("Expected {kind} to be greater or equal to {}", js_number(m)),
                    value,
                );
            }
            if let Some(m) = num("multipleOf").filter(|m| f % *m != 0.0) {
                push(
                    issues,
                    path,
                    format!("Expected {kind} to be a multiple of {}", js_number(m)),
                    value,
                );
            }
        }
        Some("boolean") if !matches!(value, Some(Value::Bool(_))) => {
            push(issues, path, "Expected boolean".into(), value)
        }
        Some("null") if value != Some(&Value::Null) => {
            push(issues, path, "Expected null".into(), value)
        }
        _ => {}
    }
}

fn visit_object(
    s: &Map<String, Value>,
    path: &str,
    value: Option<&Value>,
    issues: &mut Vec<Issue>,
) {
    let Some(Value::Object(obj)) = value else {
        return push(issues, path, "Expected object".into(), value);
    };
    let empty = Map::new();
    let props = s
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let required: Vec<&str> = s
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for key in &required {
        if !obj.contains_key(*key) {
            push(
                issues,
                &format!("{path}/{}", escape_key(key)),
                "Expected required property".into(),
                None,
            );
        }
    }
    match s.get("additionalProperties") {
        Some(Value::Bool(false)) => {
            for (key, v) in obj {
                if !props.contains_key(key) {
                    push(
                        issues,
                        &format!("{path}/{}", escape_key(key)),
                        "Unexpected property".into(),
                        Some(v),
                    );
                }
            }
        }
        Some(extra @ Value::Object(_)) => {
            for (key, v) in obj {
                if !props.contains_key(key) {
                    visit(
                        extra,
                        &format!("{path}/{}", escape_key(key)),
                        Some(v),
                        issues,
                    );
                }
            }
        }
        _ => {}
    }
    for (key, prop) in props {
        let v = obj.get(key);
        if required.contains(&key.as_str()) || v.is_some() {
            visit(prop, &format!("{path}/{}", escape_key(key)), v, issues);
        }
    }
}

/// Patterns are checked by `jsonschema`'s regex engine through a one-pattern schema, cached.
fn pattern_matches(pattern: &str, text: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<jsonschema::Validator>>>> = OnceLock::new();
    // The lock covers the lookup only, not the match.
    let validator = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(pattern.to_string())
        .or_insert_with(|| {
            Arc::new(
                jsonschema::validator_for(
                    &serde_json::json!({ "type": "string", "pattern": pattern }),
                )
                .expect("valid pattern"),
            )
        })
        .clone();
    validator.is_valid(&Value::String(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_numbers_as_javascript_does() {
        for (f, want) in [
            (3.0, "3"),
            (0.5, "0.5"),
            (-0.0, "0"),
            (1e-7, "1e-7"),
            (1e21, "1e+21"),
            (1_152_921_504_606_846_976.0, "1152921504606847000"),
            (9_223_372_036_854_775_808.0, "9223372036854776000"),
        ] {
            assert_eq!(js_number(f), want, "{f}");
        }
    }
}
