package brick

import (
	"errors"
	"fmt"
)

// Error is a Brick error envelope, identical across TypeScript, Go and Rust:
// { name, code, message, status, details?, errors?, requestId }.
type Error struct {
	Name      string  `json:"name"`
	Code      string  `json:"code"`
	Message   string  `json:"message"`
	Status    int     `json:"status"`
	Details   any     `json:"details,omitempty"`
	Errors    []Issue `json:"errors,omitempty"`
	RequestID string  `json:"requestId"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// ErrorDef is a declared error of a service, listed in its manifest.
type ErrorDef struct {
	Code    string
	Status  int
	Message string
}

// New returns the error with its default message and the given details (or none).
func (d *ErrorDef) New(details any) *Error {
	return d.With(d.Message, details)
}

// With returns the error with another message.
func (d *ErrorDef) With(message string, details any) *Error {
	return &Error{Name: "ActionExecutionError", Code: d.Code, Message: message, Status: d.Status, Details: details}
}

func validationError(action string, issues []Issue) *Error {
	return &Error{
		Name:    "ValidationError",
		Code:    "VALIDATION_FAILED",
		Message: fmt.Sprintf("Validation failed for action '%s' input", action),
		Status:  400,
		Errors:  issues,
	}
}

func internalError() *Error {
	return &Error{Name: "InternalServerError", Code: "INTERNAL_SERVER_ERROR", Message: "Internal Server Error", Status: 500}
}

func asError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}
