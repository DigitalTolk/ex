package model

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type TokenClaims struct {
	jwt.RegisteredClaims
	UserID      string     `json:"uid"`
	Email       string     `json:"email"`
	DisplayName string     `json:"name"`
	SystemRole  SystemRole `json:"role"`
}

type RefreshToken struct {
	TokenHash string    `json:"tokenHash" dynamodbav:"tokenHash"`
	UserID    string    `json:"userID" dynamodbav:"userID"`
	ExpiresAt time.Time `json:"expiresAt" dynamodbav:"expiresAt"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}
